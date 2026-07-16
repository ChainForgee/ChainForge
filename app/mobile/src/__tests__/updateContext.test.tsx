import React from 'react';
import { View, Text } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';
import { UpdateProvider, useUpdate } from '../contexts/UpdateContext';
import * as updateService from '../services/updateService';

// Mock AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(),
  getItem: jest.fn(),
  removeItem: jest.fn(),
}));

// Mock Constants from expo-constants
jest.mock('expo-constants', () => ({
  expoConfig: {
    version: '1.0.0',
  },
}));

// Test component to access the update context
const TestComponent = () => {
  const update = useUpdate();
  return (
    <View>
      <Text testID="loading">{update.isLoading ? 'loading' : 'done'}</Text>
      <Text testID="versionInfo">{update.versionInfo?.latestVersion || 'null'}</Text>
    </View>
  );
};

describe('UpdateProvider - Token Expiry Handling', () => {
  const mockVersionInfo = {
    latestVersion: '1.1.0',
    minRequiredVersion: '1.0.0',
    releaseNotes: ['Test note'],
    storeUrl: { ios: 'https://ios', android: 'https://android' },
  };

  let fetchVersionInfoSpy: jest.SpyInstance;
  let setAuthTokenSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchVersionInfoSpy = jest.spyOn(updateService, 'fetchVersionInfo');
    setAuthTokenSpy = jest.spyOn(updateService, 'setAuthToken');
  });

  it('should refresh token and retry on 401 error', async () => {
    // First call returns 401, second call returns success
    let callCount = 0;
    fetchVersionInfoSpy.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const error = new Error('Unauthorized');
        (error as any).status = 401;
        throw error;
      }
      return mockVersionInfo;
    });

    const { getByTestId } = render(
      <UpdateProvider>
        <TestComponent />
      </UpdateProvider>
    );

    await waitFor(() => {
      expect(getByTestId('loading')).toHaveTextContent('done');
    });

    // Verify fetch was called twice (first failed, second succeeded)
    expect(fetchVersionInfoSpy).toHaveBeenCalledTimes(2);
    // Verify setAuthToken was called to set new token
    expect(setAuthTokenSpy).toHaveBeenCalledTimes(1);
    // Verify version info was successfully fetched on retry
    expect(getByTestId('versionInfo')).toHaveTextContent(mockVersionInfo.latestVersion);
  });

  it('should not retry more than once', async () => {
    fetchVersionInfoSpy.mockImplementation(async () => {
      const error = new Error('Unauthorized');
      (error as any).status = 401;
      throw error;
    });

    render(
      <UpdateProvider>
        <TestComponent />
      </UpdateProvider>
    );

    await waitFor(() => {
      expect(fetchVersionInfoSpy).toHaveBeenCalledTimes(2); // Initial + 1 retry
    });
  });
});
