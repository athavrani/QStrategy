import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { DhanWebLoginModal } from '../components/settings/DhanWebLoginModal';
import { secureVault } from '../services/SecureCredentialVault';
import { dhanDirectService } from '../services/dhanDirectService';
import { dhanHqFeedSocket } from '../services/dhan/DhanHqFeedSocket';

jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    WebView: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({
        injectJavaScript: jest.fn(),
        reload: jest.fn(),
      }));
      return <View testID="mock-webview" {...props} />;
    }),
  };
});

jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn().mockResolvedValue(true),
  selectionAsync: jest.fn().mockResolvedValue(true),
  NotificationFeedbackType: {
    Success: 'success',
  },
}));

jest.mock('../services/SecureCredentialVault', () => ({
  secureVault: {
    saveCredentials: jest.fn().mockResolvedValue(true),
    getCredentials: jest.fn().mockResolvedValue({ clientId: '1100345678', accessToken: 'mock-token' }),
  },
}));

jest.mock('../services/dhanDirectService', () => ({
  dhanDirectService: {
    saveCredentials: jest.fn().mockResolvedValue(true),
  },
}));

jest.mock('../services/dhan/DhanHqFeedSocket', () => ({
  dhanHqFeedSocket: {
    start: jest.fn(),
  },
}));

const mockInitStreamer = jest.fn();
const mockRefreshAll = jest.fn().mockResolvedValue(true);

jest.mock('../store/useRadarStore', () => ({
  useRadarStore: {
    getState: () => ({
      initStreamer: mockInitStreamer,
      refreshAll: mockRefreshAll,
    }),
  },
}));

describe('DhanWebLoginModal: Live Stream Connection & Window Preservation', () => {
  let activeTrees: renderer.ReactTestRenderer[] = [];

  const getText = (node: any): string => {
    if (!node) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(getText).join('');
    if (node.props && node.props.children) return getText(node.props.children);
    return '';
  };

  beforeEach(() => {
    jest.clearAllMocks();
    activeTrees = [];
  });

  afterEach(() => {
    activeTrees.forEach((t) => {
      try {
        t.unmount();
      } catch {
        // Ignore
      }
    });
    activeTrees = [];
  });

  test('does not close window when credentials are captured, allowing user to see and copy webview data', async () => {
    const onClose = jest.fn();
    const onSuccess = jest.fn();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <DhanWebLoginModal visible={true} onClose={onClose} onSuccess={onSuccess} />
      );
      activeTrees.push(tree);
    });

    const root = tree.root;
    const webView = root.findByProps({ testID: 'mock-webview' });
    expect(webView).toBeTruthy();

    const validExpSec = Math.floor(Date.now() / 1000) + 86400;
    const base64Payload = Buffer.from(
      JSON.stringify({
        dhanClientId: '1100345678',
        name: 'Arjun Trader',
        exp: validExpSec,
      })
    ).toString('base64');
    const mockJwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${base64Payload}.signature1234567890`;

    // Simulate login completion / token interception from webview
    await act(async () => {
      await webView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'DHAN_RAW_NETWORK_RESPONSE',
            body: JSON.stringify({
              token_id: mockJwt,
              entity_id: '1100345678',
              client_name: 'Arjun Trader',
            }),
          }),
        },
      });
    });

    // 1. Credentials must be saved & background stream started
    expect(secureVault.saveCredentials).toHaveBeenCalledWith('1100345678', mockJwt);
    expect(dhanDirectService.saveCredentials).toHaveBeenCalledWith('1100345678', mockJwt);
    expect(onSuccess).toHaveBeenCalledWith('1100345678', mockJwt);
    expect(dhanHqFeedSocket.start).toHaveBeenCalled();
    expect(mockInitStreamer).toHaveBeenCalled();

    // 2. Window MUST NOT be closed! (User requested keeping it open to view and copy data)
    expect(onClose).not.toHaveBeenCalled();

    // 3. UI renders the connected banner and copy actions
    const texts = root.findAllByType('Text' as any).map((t) => getText(t)).join(' ');

    expect(texts).toContain('Dhan Live Stream Connected & Synced');
    expect(texts).toContain('1100345678');
    expect(texts).toContain('Copy Token');
    expect(texts).toContain('Copy Client ID');
    expect(texts).toContain('Return to App');
  });

  test('tapping Return to App calls onClose when user finishes inspecting webview', async () => {
    const onClose = jest.fn();
    const onSuccess = jest.fn();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <DhanWebLoginModal visible={true} onClose={onClose} onSuccess={onSuccess} />
      );
      activeTrees.push(tree);
    });

    const root = tree.root;
    const webView = root.findByProps({ testID: 'mock-webview' });

    const validExpSec = Math.floor(Date.now() / 1000) + 86400;
    const base64Payload = Buffer.from(
      JSON.stringify({
        dhanClientId: '1100345678',
        name: 'Arjun Trader',
        exp: validExpSec,
      })
    ).toString('base64');
    const mockJwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${base64Payload}.signature1234567890`;

    await act(async () => {
      await webView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'DHAN_RAW_NETWORK_RESPONSE',
            body: JSON.stringify({
              token_id: mockJwt,
              entity_id: '1100345678',
              client_name: 'Arjun Trader',
            }),
          }),
        },
      });
    });

    expect(onClose).not.toHaveBeenCalled();

    // Find the Return to App TouchableOpacity by testID
    const returnHeaderBtn = root.findByProps({ testID: 'dhan-header-return-btn' });
    expect(returnHeaderBtn).toBeTruthy();

    await act(async () => {
      returnHeaderBtn.props.onPress();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('copy token triggers copyToClipboard without closing the modal', async () => {
    const onClose = jest.fn();
    const onSuccess = jest.fn();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <DhanWebLoginModal visible={true} onClose={onClose} onSuccess={onSuccess} />
      );
      activeTrees.push(tree);
    });

    const root = tree.root;
    const webView = root.findByProps({ testID: 'mock-webview' });

    const validExpSec = Math.floor(Date.now() / 1000) + 86400;
    const base64Payload = Buffer.from(
      JSON.stringify({
        dhanClientId: '1100345678',
        name: 'Arjun Trader',
        exp: validExpSec,
      })
    ).toString('base64');
    const mockJwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${base64Payload}.signature1234567890`;

    await act(async () => {
      await webView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'DHAN_RAW_NETWORK_RESPONSE',
            body: JSON.stringify({
              token_id: mockJwt,
              entity_id: '1100345678',
              client_name: 'Arjun Trader',
            }),
          }),
        },
      });
    });

    const copyBtn = root.findByProps({ testID: 'dhan-copy-token-btn' });
    expect(copyBtn).toBeTruthy();

    await act(async () => {
      copyBtn.props.onPress();
    });

    // Window must still remain open!
    expect(onClose).not.toHaveBeenCalled();

    // Inspect Details button toggles details view
    const inspectBtn = root.findByProps({ testID: 'dhan-inspect-details-btn' });
    expect(inspectBtn).toBeTruthy();

    await act(async () => {
      inspectBtn.props.onPress();
    });

    const textInputs = root.findAllByType('TextInput' as any);
    expect(textInputs.length).toBeGreaterThanOrEqual(2);
    expect(textInputs.some((ti) => ti.props.value === '1100345678')).toBe(true);
    expect(textInputs.some((ti) => ti.props.value === mockJwt)).toBe(true);
  });
});
