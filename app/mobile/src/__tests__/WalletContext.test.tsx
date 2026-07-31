import React from 'react';
import { render, act, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WalletProvider, useWallet } from '../contexts/WalletContext';
import * as WalletConnectService from '../services/walletConnect';
import * as ExpoLinking from 'expo-linking';

jest.mock('../services/walletConnect', () => ({
  createWalletConnection: jest.fn(),
  restoreWalletSession: jest.fn(),
  openWalletConnectPairingUri: jest.fn(),
  disconnectWalletSession: jest.fn(),
}));

jest.mock('expo-linking', () => ({
  getInitialURL: jest.fn().mockResolvedValue(null),
  addEventListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
}));

describe('WalletContext', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    (WalletConnectService.restoreWalletSession as jest.Mock).mockResolvedValue(null);
  });

  const TestComponent = ({ onStateChange }: { onStateChange?: (state: any) => void }) => {
    const walletState = useWallet();
    
    React.useEffect(() => {
      onStateChange?.(walletState);
    }, [walletState, onStateChange]);

    return null;
  };

  it('persists pairing URI across app restarts', async () => {
    // A mock approval that never resolves so we stay in awaiting-approval
    const mockApproval = jest.fn(() => new Promise(() => {}));
    const testUri = 'wc:test-uri-123';
    
    (WalletConnectService.createWalletConnection as jest.Mock).mockResolvedValue({
      pairingUri: testUri,
      approval: mockApproval,
    });

    let currentState: any;
    const { unmount } = render(
      <WalletProvider>
        <TestComponent onStateChange={(s) => { currentState = s; }} />
      </WalletProvider>
    );

    // Ensure bootstrap has finished and initial state is null
    await waitFor(() => {
      expect(currentState).toBeTruthy();
    });
    expect(currentState.pairingUri).toBeNull();

    // Trigger pairing
    await act(async () => {
      // Intentionally not awaiting the full connectWallet, 
      // but waiting for the state to settle after setPairingUri
      currentState.connectWallet().catch(() => {});
    });

    await waitFor(() => {
      expect(currentState.pairingUri).toBe(testUri);
    });

    // Check it's persisted in AsyncStorage mock
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('@chainforge:pairing', testUri);
    const storedUri = await AsyncStorage.getItem('@chainforge:pairing');
    expect(storedUri).toBe(testUri);

    // Simulate app kill
    unmount();
    currentState = null;

    // Simulate restart (remount)
    render(
      <WalletProvider>
        <TestComponent onStateChange={(s) => { currentState = s; }} />
      </WalletProvider>
    );

    // Assert the restored pairingUri matches what was generated
    await waitFor(() => {
      expect(currentState.pairingUri).toBe(testUri);
    });
  });
});
