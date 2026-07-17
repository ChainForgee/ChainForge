# Mobile Encrypted Storage

## Overview
The ChainForge mobile app uses `expo-secure-store` to store sensitive information securely on both iOS and Android. This module provides encryption at rest using platform-native secure storage mechanisms.

## Platform Details

### Android
On Android, `expo-secure-store` uses the system's KeyStore to generate and store encryption keys, and encrypts values in SharedPreferences.

### iOS
On iOS, `expo-secure-store` uses the system Keychain, providing strong encryption. The data persists even when the app is uninstalled (as is Keychain behavior).

## Sensitive Storage Keys
All sensitive keys are defined in `app/mobile/src/services/storage.ts`.

### Current Sensitive Keys
- `@ChainForge:AuthToken`: Stores the authentication token for API requests.
- (WalletConnect session data): WalletConnect session data (topic, public key, etc.) are stored via WalletConnect's internal storage.

## How to Use the Storage Service

### Import
```typescript
import { getItem, setItem, removeItem, registerSensitiveKey } from './storage';
```

### Set an Item
```typescript
// Sensitive keys are automatically stored in SecureStore if they're in the SENSITIVE_KEYS set.
await setItem('@ChainForge:AuthToken', 'some-token-value');
```

### Register a New Sensitive Key
```typescript
registerSensitiveKey('@ChainForge:NewSensitiveKey');
await setItem('@ChainForge:NewSensitiveKey', 'sensitive-value');
```

## Testing
The storage service tests ensure sensitive keys are stored in `expo-secure-store` and non‑sensitive keys are stored in AsyncStorage.
