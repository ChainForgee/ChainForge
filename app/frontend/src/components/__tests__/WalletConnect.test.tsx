/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  getAddress,
  getNetworkDetails,
  isConnected,
  setAllowed,
} from '@stellar/freighter-api';
import { WalletConnect } from '../WalletConnect';
import { useWalletStore } from '@/lib/walletStore';
import { useToast } from '../ToastProvider';
import { useNetworkGuard } from '@/hooks/useNetworkGuard';

jest.mock('@stellar/freighter-api', () => ({
  isConnected: jest.fn(),
  setAllowed: jest.fn(),
  getAddress: jest.fn(),
  getNetworkDetails: jest.fn(),
}));

jest.mock('@/lib/walletStore', () => ({
  useWalletStore: jest.fn(),
}));

jest.mock('../ToastProvider', () => ({
  useToast: jest.fn(),
}));

jest.mock('@/hooks/useNetworkGuard', () => ({
  useNetworkGuard: jest.fn(),
}));

jest.mock('@/lib/explorer', () => ({
  buildExplorerUrl: (_type: string, identifier: string) =>
    `https://stellar.expert/explorer/testnet/address/${identifier}`,
}));

const mockIsConnected = isConnected as jest.MockedFunction<typeof isConnected>;
const mockSetAllowed = setAllowed as jest.MockedFunction<typeof setAllowed>;
const mockGetAddress = getAddress as jest.MockedFunction<typeof getAddress>;
const mockGetNetworkDetails = getNetworkDetails as jest.MockedFunction<
  typeof getNetworkDetails
>;
const mockUseWalletStore = useWalletStore as unknown as jest.MockedFunction<
  () => {
    publicKey: string | null;
    network: string | null;
    setPublicKey: jest.Mock;
    setNetwork: jest.Mock;
    disconnect: jest.Mock;
  }
>;
const mockUseToast = useToast as jest.MockedFunction<typeof useToast>;
const mockUseNetworkGuard = useNetworkGuard as jest.MockedFunction<
  typeof useNetworkGuard
>;

const toast = jest.fn();
const setPublicKey = jest.fn();
const setNetwork = jest.fn();
const disconnect = jest.fn();
let walletState = {
  publicKey: null as string | null,
  network: null as string | null,
};

function mockWallet() {
  mockUseWalletStore.mockReturnValue({
    ...walletState,
    setPublicKey,
    setNetwork,
    disconnect,
  });
  mockUseToast.mockReturnValue({ toast } as ReturnType<typeof useToast>);
  mockUseNetworkGuard.mockReturnValue({
    isCorrectNetwork: true,
    isMismatch: false,
    walletNetwork: walletState.network,
    expectedNetwork: 'TESTNET',
  });
}

describe('WalletConnect', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'FreighterApi', {
      configurable: true,
      value: {},
    });
    walletState = { publicKey: null, network: null };
    toast.mockClear();
    setPublicKey.mockClear();
    setNetwork.mockClear();
    disconnect.mockClear();
    mockIsConnected.mockResolvedValue({ isConnected: false });
    mockSetAllowed.mockResolvedValue(undefined);
    mockGetAddress.mockResolvedValue({
      address: 'GABC1234567890XYZ',
    });
    mockGetNetworkDetails.mockResolvedValue({ network: 'TESTNET' });
    mockWallet();
  });

  it('connects Freighter and stores the returned address and network', async () => {
    render(<WalletConnect />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Connect Freighter Wallet' }),
    );

    await waitFor(() => {
      expect(mockSetAllowed).toHaveBeenCalled();
      expect(setPublicKey).toHaveBeenCalledWith('GABC1234567890XYZ');
      expect(setNetwork).toHaveBeenCalledWith('TESTNET');
      expect(toast).toHaveBeenCalledWith(
        'Wallet Connected',
        'Successfully connected to Freighter',
        'success',
      );
    });
  });

  it('renders connected wallet state and disconnects locally', async () => {
    walletState = {
      publicKey: 'GCONNECTED1234567890',
      network: 'PUBLIC',
    };
    mockIsConnected.mockResolvedValue({ isConnected: true });
    mockGetAddress.mockResolvedValue({ address: walletState.publicKey });
    mockGetNetworkDetails.mockResolvedValue({ network: 'PUBLIC' });
    mockWallet();

    render(<WalletConnect />);

    expect(await screen.findByText('GCON...7890')).toBeInTheDocument();
    expect(screen.getByText('PUBLIC')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(disconnect).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      'Disconnected',
      'Wallet has been disconnected',
      'info',
    );
  });

  it('shows a retryable error when the user rejects connection', async () => {
    mockSetAllowed.mockRejectedValue(new Error('User declined'));

    render(<WalletConnect />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Connect Freighter Wallet' }),
    );

    expect(
      await screen.findByText('Connection cancelled by user.'),
    ).toBeInTheDocument();
    expect(setPublicKey).toHaveBeenCalledWith(null);
    expect(toast).toHaveBeenCalledWith(
      'Connection Rejected',
      'Connection cancelled by user.',
      'error',
    );
  });
});
