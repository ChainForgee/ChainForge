import React, { createContext, useContext, useState, useEffect } from 'react';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { VersionInfo, UpdateState } from '../types/update';
import { 
  fetchVersionInfo, 
  compareVersions, 
  clearAuthToken,
  setAuthToken,
} from '../services/updateService';

interface UpdateContextType extends UpdateState {
  markReleaseNotesSeen: () => Promise<void>;
  checkUpdates: () => Promise<void>;
  isLoading: boolean;
}

const UpdateContext = createContext<UpdateContextType | undefined>(undefined);

const SEEN_RELEASE_NOTES_KEY = '@ChainForge:SeenReleaseNotes';

// Mock refresh token function for now
const refreshAuthToken = async (): Promise<string> => {
  // In real app, this would call your refresh token endpoint
  console.log('UpdateProvider: Refreshing auth token');
  // For demo, just return a new mock token
  return `new-mock-token-${Date.now()}`;
};

export const UpdateProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<UpdateState>({
    isUpdateAvailable: false,
    isForceUpgrade: false,
    versionInfo: null,
    hasSeenReleaseNotes: true,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [authRetryCount, setAuthRetryCount] = useState(0);

  const currentVersion = Constants.expoConfig?.version || '0.0.0';

  const checkUpdates = async () => {
    try {
      setIsLoading(true);
      const versionInfo = await fetchVersionInfo();
      
      const updateAvailable = compareVersions(versionInfo.latestVersion, currentVersion) > 0;
      const forceUpgrade = compareVersions(versionInfo.minRequiredVersion, currentVersion) > 0;
      
      let hasSeen = true;
      if (updateAvailable) {
        const storedVersion = await AsyncStorage.getItem(SEEN_RELEASE_NOTES_KEY);
        hasSeen = storedVersion === versionInfo.latestVersion;
      }

      setState({
        isUpdateAvailable: updateAvailable,
        isForceUpgrade: forceUpgrade,
        versionInfo,
        hasSeenReleaseNotes: hasSeen,
      });
      setAuthRetryCount(0); // Reset retry count on success
    } catch (error: any) {
      console.error('UpdateProvider: Failed to check for updates', error);
      // If we get a 401, try to refresh token and retry
      if (error.status === 401 && authRetryCount < 1) {
        console.log('UpdateProvider: Received 401, refreshing token');
        try {
          const newToken = await refreshAuthToken();
          await setAuthToken(newToken);
          setAuthRetryCount(prev => prev + 1);
          await checkUpdates(); // Retry after refreshing
        } catch (refreshError) {
          console.error('UpdateProvider: Failed to refresh token', refreshError);
          await clearAuthToken();
        }
      }
    } finally {
      setIsLoading(false);
    }
  };

  const markReleaseNotesSeen = async () => {
    if (state.versionInfo) {
      await AsyncStorage.setItem(SEEN_RELEASE_NOTES_KEY, state.versionInfo.latestVersion);
      setState(prev => ({ ...prev, hasSeenReleaseNotes: true }));
    }
  };

  useEffect(() => {
    checkUpdates();
  }, []);

  return (
    <UpdateContext.Provider 
      value={{ 
        ...state, 
        markReleaseNotesSeen, 
        checkUpdates,
        isLoading 
      }}
    >
      {children}
    </UpdateContext.Provider>
  );
};

export const useUpdate = () => {
  const context = useContext(UpdateContext);
  if (context === undefined) {
    throw new Error('useUpdate must be used within an UpdateProvider');
  }
  return context;
};
