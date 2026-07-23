import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text, View } from 'react-native';
import { fetchAidDetails } from '../services/aidApi';
import { SyncProvider, useSync } from './SyncContext';

type NetworkListener = (state: {
  isConnected: boolean;
  isInternetReachable: boolean;
}) => void;

let mockNetworkListener: NetworkListener | undefined;

jest.mock('@react-native-community/netinfo', () => {
  const addEventListener = jest.fn((listener: NetworkListener) => {
    mockNetworkListener = listener;
    return jest.fn();
  });

  return {
    __esModule: true,
    default: {
      addEventListener,
      fetch: jest.fn(),
    },
    addEventListener,
    fetch: jest.fn(),
  };
});

jest.mock('../services/aidApi', () => ({
  fetchAidDetails: jest.fn(),
  submitClaim: jest.fn(),
}));

jest.mock('../config', () => ({
  config: { apiUrl: 'http://localhost:3000' },
}));

jest.mock('./SaverModeContext', () => ({
  useSaverMode: () => ({ active: false }),
}));

const mockFetchAidDetails = fetchAidDetails as jest.MockedFunction<typeof fetchAidDetails>;

const SyncTestConsumer = () => {
  const {
    failedCount,
    isConnected,
    pendingCount,
    queueStatusRefresh,
  } = useSync();

  const queueActions = async () => {
    await queueStatusRefresh('aid-1');
    await queueStatusRefresh('aid-2');
    await queueStatusRefresh('aid-3');
  };

  return (
    <View>
      <Text testID="network-status">{isConnected ? 'online' : 'offline'}</Text>
      <Text testID="pending-count">{pendingCount}</Text>
      <Text testID="failed-count">{failedCount}</Text>
      <Pressable testID="queue-actions" onPress={queueActions}>
        <Text>Queue actions</Text>
      </Pressable>
    </View>
  );
};

const emitNetworkState = (isConnected: boolean) => {
  if (!mockNetworkListener) {
    throw new Error('NetInfo listener was not registered');
  }

  mockNetworkListener({
    isConnected,
    isInternetReachable: isConnected,
  });
};

describe('SyncProvider', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockNetworkListener = undefined;
    await AsyncStorage.removeItem('@chainforge/sync-queue');

    mockFetchAidDetails.mockImplementation(async (aidId) => ({
      id: aidId,
      title: `Aid ${aidId}`,
      description: 'Test aid package',
      recipient: {
        name: 'Test Recipient',
        id: 'recipient-1',
        wallet: 'GTEST',
      },
      tokenType: 'USDC',
      amount: '100',
      expiryDate: '2026-12-31T00:00:00.000Z',
      status: 'verified',
      claimId: `claim-${aidId}`,
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
  });

  it('drains all queued actions when the network reconnects', async () => {
    const { getByTestId } = render(
      <SyncProvider>
        <SyncTestConsumer />
      </SyncProvider>,
    );

    await act(async () => {
      emitNetworkState(false);
    });
    await waitFor(() => expect(getByTestId('network-status').props.children).toBe('offline'));

    fireEvent.press(getByTestId('queue-actions'));

    await waitFor(() => expect(getByTestId('pending-count').props.children).toBe(3));
    expect(mockFetchAidDetails).not.toHaveBeenCalled();

    await act(async () => {
      emitNetworkState(true);
    });

    await waitFor(() => expect(mockFetchAidDetails).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(getByTestId('pending-count').props.children).toBe(0));

    expect(mockFetchAidDetails).toHaveBeenNthCalledWith(1, 'aid-1');
    expect(mockFetchAidDetails).toHaveBeenNthCalledWith(2, 'aid-2');
    expect(mockFetchAidDetails).toHaveBeenNthCalledWith(3, 'aid-3');
    expect(getByTestId('failed-count').props.children).toBe(0);
  });
});
