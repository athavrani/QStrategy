// QStrategy — Dhan Web In-App Login & Instant Token Sync Modal

import React, { useState, useRef, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Haptics from 'expo-haptics';
import CryptoJS from 'crypto-js';
import { useTheme, createThemedStyles } from '../../theme';
import { secureVault } from '../../services/SecureCredentialVault';
import { dhanDirectService } from '../../services/dhanDirectService';
import { dhanHqFeedSocket } from '../../services/dhan/DhanHqFeedSocket';
import { useRadarStore } from '../../store/useRadarStore';

interface DhanWebLoginModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: (clientId: string, token: string) => void;
}

// AES-128-CBC decryption matching Dhan Web's internal CryptoJS engine
function decryptDhanStorage(cipherTextBase64: string): string {
  if (!cipherTextBase64 || typeof cipherTextBase64 !== 'string') return '';
  try {
    const key = CryptoJS.PBKDF2('DHAN', CryptoJS.enc.Hex.parse('498960e491150a0fc0f21822a147fd62'), {
      keySize: 4,
      iterations: 1000,
    });
    const cipherParams = CryptoJS.lib.CipherParams.create({
      ciphertext: CryptoJS.enc.Base64.parse(cipherTextBase64),
    });
    const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
      iv: CryptoJS.enc.Hex.parse('320ef7705d1030f0a1a55b3dcf676cb8'),
    }).toString(CryptoJS.enc.Utf8);
    return decrypted;
  } catch {
    return '';
  }
}

const JWT_REGEX = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g;

function decodeJwtPayload(jwt: string): any {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) {
      b64 += '=';
    }
    const decodedStr = CryptoJS.enc.Base64.parse(b64).toString(CryptoJS.enc.Utf8);
    if (!decodedStr) return null;
    return JSON.parse(decodedStr);
  } catch {
    return null;
  }
}

// Universal parser for raw network JSON, AES-encrypted storage values, cookies, URLs, and JWTs
function tryExtractCredentials(raw: any, depth = 0): { clientId: string; token: string; name: string } | null {
  if (!raw || depth > 5) return null;

  // Case 1: Plain string input
  if (typeof raw === 'string') {
    const trimmed = raw.trim();

    // 1A. Check if string directly contains a JWT
    const jwtMatches = trimmed.match(JWT_REGEX);
    if (jwtMatches && jwtMatches.length > 0) {
      for (const jwt of jwtMatches) {
        const payload = decodeJwtPayload(jwt);
        if (!payload) continue;

        // Strict expiration check: reject expired tokens
        if (payload.exp && typeof payload.exp === 'number') {
          const nowSec = Math.floor(Date.now() / 1000);
          if (payload.exp <= nowSec) {
            continue; // Token is expired, reject it
          }
        }

        const clientId =
          payload?.dhanClientId ||
          payload?.clientId ||
          payload?.client_id ||
          payload?.dhan_client_id ||
          payload?.login_id ||
          payload?.entity_id ||
          payload?.sub ||
          payload?.userId;
        const name = payload?.name || payload?.client_name || payload?.user_name || 'Dhan Trader';
        return {
          clientId: clientId ? String(clientId) : '',
          token: jwt,
          name: String(name),
        };
      }
    }

    // 1B. Check if string is encrypted ciphertext (Dhan Web uses AES-128-CBC)
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      const dec = decryptDhanStorage(trimmed);
      if (dec && dec !== trimmed) {
        const creds = tryExtractCredentials(dec, depth + 1);
        if (creds) return creds;
      }
    }

    // 1C. Check if string is JSON
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        const creds = tryExtractCredentials(parsed, depth + 1);
        if (creds) return creds;
      } catch {}
    }

    // 1D. Check if string is cookie-formatted ("a=b; c=d")
    if (trimmed.includes('=')) {
      const pairs = trimmed.split(';');
      for (const pair of pairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx !== -1) {
          const val = pair.slice(eqIdx + 1).trim();
          if (val.includes('eyJ') || val.length > 40) {
            const creds = tryExtractCredentials(val, depth + 1);
            if (creds) return creds;
          }
        }
      }
    }

    // Rule 1E removed: Never treat arbitrary strings as tokens without JWT or explicit Dhan payload
    return null;
  }

  // Case 2: Object / Array input
  if (typeof raw === 'object') {
    // If it's an array, scan each element
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const creds = tryExtractCredentials(item, depth + 1);
        if (creds) return creds;
      }
      return null;
    }

    // Known token field names in Dhan responses and storage
    const tokenCandidates = [
      raw.token_id,
      raw.jwt,
      raw.token,
      raw.TxnToken,
      raw.accessToken,
      raw.access_token,
      raw.authToken,
      raw.auth_token,
      raw.sessionToken,
      raw.session_token,
      raw.tokenId,
      raw.id_token,
      raw.JWTtoken,
    ];

    const rawClientId = raw.entity_id || raw.login_id || raw.clientId || raw.client_id || raw.dhanClientId || raw.userId;
    const rawName = raw.client_name || raw.name || raw.user_name || raw.trader_name;

    for (const cand of tokenCandidates) {
      if (cand && typeof cand === 'string') {
        const creds = tryExtractCredentials(cand, depth + 1);
        if (creds) {
          return {
            clientId: rawClientId ? String(rawClientId) : creds.clientId,
            token: creds.token,
            name: rawName ? String(rawName) : creds.name,
          };
        }
        // If candidate is a token accompanied by confirmed rawClientId
        if (rawClientId && cand.length >= 20 && !cand.includes(' ') && !cand.includes('<') && !cand.includes('{')) {
          return {
            clientId: String(rawClientId),
            token: cand,
            name: rawName ? String(rawName) : 'Dhan Trader',
          };
        }
      }
    }

    // Check nested .data field
    if (raw.data && typeof raw.data === 'object') {
      const creds = tryExtractCredentials(raw.data, depth + 1);
      if (creds) {
        return {
          clientId: rawClientId ? String(rawClientId) : creds.clientId,
          token: creds.token,
          name: rawName ? String(rawName) : creds.name,
        };
      }
    }

    // Deep scan only object keys that could plausibly contain tokens or encrypted values
    for (const key of Object.keys(raw)) {
      const val = raw[key];
      const lowerKey = key.toLowerCase();
      if (
        typeof val === 'string' &&
        (val.includes('eyJ') || lowerKey.includes('token') || lowerKey.includes('user') || lowerKey.includes('auth'))
      ) {
        const creds = tryExtractCredentials(val, depth + 1);
        if (creds) {
          return {
            clientId: rawClientId ? String(rawClientId) : creds.clientId,
            token: creds.token,
            name: rawName ? String(rawName) : creds.name,
          };
        }
      } else if (typeof val === 'object' && val !== null && depth < 2) {
        const creds = tryExtractCredentials(val, depth + 1);
        if (creds) {
          return {
            clientId: rawClientId ? String(rawClientId) : creds.clientId,
            token: creds.token,
            name: rawName ? String(rawName) : creds.name,
          };
        }
      }
    }
  }

  return null;
}

const DESKTOP_VIEWPORT_INJECTION = `
  (function() {
    // 1. Force desktop viewport & window/screen dimensions so @media (max-width: 600px) NEVER matches
    try {
      Object.defineProperty(window, 'innerWidth', { get: function() { return 1280; }, configurable: true });
      Object.defineProperty(window, 'outerWidth', { get: function() { return 1280; }, configurable: true });
      Object.defineProperty(screen, 'width', { get: function() { return 1280; }, configurable: true });
      Object.defineProperty(screen, 'availWidth', { get: function() { return 1280; }, configurable: true });
      Object.defineProperty(navigator, 'userAgent', {
        get: function() { return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"; },
        configurable: true
      });
      Object.defineProperty(navigator, 'platform', { get: function() { return "Win32"; }, configurable: true });
    } catch(e) {}

    // 2. Kill mobile landing screen completely
    function applyDesktopStyles() {
      try {
        var styleId = 'dhan-mobile-block-killer';
        if (!document.getElementById(styleId)) {
          var s = document.createElement('style');
          s.id = styleId;
          s.innerHTML = [
            'body { overflow-x: auto !important; }',
            '* { -webkit-user-select: text !important; -moz-user-select: text !important; -ms-user-select: text !important; user-select: text !important; -webkit-touch-callout: default !important; }',
            '.webmobile, app-mobilelanding { display: none !important; visibility: hidden !important; height: 0 !important; max-height: 0 !important; overflow: hidden !important; pointer-events: none !important; }',
            '.webpage { display: block !important; visibility: visible !important; opacity: 1 !important; height: auto !important; min-height: 100vh !important; }',
            '@media only screen and (max-width: 900px) {',
            '  .webmobile, app-mobilelanding { display: none !important; visibility: hidden !important; height: 0 !important; }',
            '  .webpage { display: block !important; visibility: visible !important; }',
            '}'
          ].join(' ');
          (document.head || document.documentElement).appendChild(s);
        }

        var meta = document.querySelector('meta[name="viewport"]');
        if (!meta) {
          meta = document.createElement('meta');
          meta.name = 'viewport';
          (document.head || document.documentElement).appendChild(meta);
        }
        meta.content = 'width=1280, initial-scale=0.5, minimum-scale=0.25, maximum-scale=5.0, user-scalable=yes';
      } catch(e) {}
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', applyDesktopStyles);
    } else {
      applyDesktopStyles();
    }
    var cssTimer = setInterval(applyDesktopStyles, 500);
    setTimeout(function() { clearInterval(cssTimer); }, 15000);

    // Helper for programmatic clipboard copy from RN
    try {
      window.qStrategyCopyToClipboard = function(text) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text);
          }
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          return true;
        } catch(e) {
          return false;
        }
      };
    } catch(e) {}

    // 3. Network Fetch & XHR Interception (catches plain-text OTP login response instantly)
    try {
      if (window.fetch) {
        var origFetch = window.fetch;
        window.fetch = function() {
          return origFetch.apply(this, arguments).then(function(res) {
            try {
              var clone = res.clone();
              clone.text().then(function(txt) {
                if (txt && (txt.indexOf('token_id') !== -1 || txt.indexOf('token') !== -1 || txt.indexOf('jwt') !== -1 || txt.indexOf('eyJ') !== -1)) {
                  window.ReactNativeWebView.postMessage(JSON.stringify({
                    type: 'DHAN_RAW_NETWORK_RESPONSE',
                    body: txt
                  }));
                }
              }).catch(function(){});
            } catch(e) {}
            return res;
          });
        };
      }
    } catch(e) {}

    try {
      if (window.XMLHttpRequest) {
        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function() {
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
          this.addEventListener('load', function() {
            try {
              var txt = this.responseText;
              if (txt && (txt.indexOf('token_id') !== -1 || txt.indexOf('token') !== -1 || txt.indexOf('jwt') !== -1 || txt.indexOf('eyJ') !== -1)) {
                window.ReactNativeWebView.postMessage(JSON.stringify({
                  type: 'DHAN_RAW_NETWORK_RESPONSE',
                  body: txt
                }));
              }
            } catch(e) {}
          });
          return origSend.apply(this, arguments);
        };
      }
    } catch(e) {}

    // 4. Hook localStorage.setItem and sessionStorage.setItem to catch storage writes continuously
    try {
      var origLocalSet = window.localStorage.setItem;
      window.localStorage.setItem = function(key, val) {
        origLocalSet.apply(this, arguments);
        try {
          var href = (window.location.href || '').toLowerCase();
          if (href.indexOf('login') === -1 && href.indexOf('auth') === -1) {
            if (key === 'userdata' || key === 'JWTtoken' || key === 'TxnToken' || key === 'first_auth' || key === 'token' || (val && typeof val === 'string' && val.indexOf('eyJ') !== -1)) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'DHAN_ENCRYPTED_STORAGE',
                key: key,
                value: val
              }));
            }
          }
        } catch(e) {}
      };
    } catch(e) {}

    try {
      var origSessionSet = window.sessionStorage.setItem;
      window.sessionStorage.setItem = function(key, val) {
        origSessionSet.apply(this, arguments);
        try {
          var href = (window.location.href || '').toLowerCase();
          if (href.indexOf('login') === -1 && href.indexOf('auth') === -1) {
            if (key === 'userdata' || key === 'JWTtoken' || key === 'TxnToken' || key === 'first_auth' || key === 'token' || (val && typeof val === 'string' && val.indexOf('eyJ') !== -1)) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'DHAN_ENCRYPTED_STORAGE',
                key: key,
                value: val
              }));
            }
          }
        } catch(e) {}
      };
    } catch(e) {}
  })();
  true;
`;

const INJECTED_TOKEN_INTERCEPTOR = `
  (function() {
    function isLoginPage() {
      try {
        var href = (window.location.href || '').toLowerCase();
        var path = (window.location.pathname || '').toLowerCase();
        return href.indexOf('login') !== -1 || href.indexOf('auth') !== -1 || href.indexOf('signin') !== -1 || path.indexOf('login') !== -1;
      } catch(e) {
        return false;
      }
    }

    function checkStorage() {
      try {
        // NEVER auto-check or auto-dump while on login screen!
        if (isLoginPage()) {
          return;
        }

        var dump = {};
        var keys = ['userdata', 'JWTtoken', 'token', 'first_auth', 'TxnToken', 'access_token', 'auth'];
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          var lv = window.localStorage.getItem(k);
          if (lv) dump['ls_' + k] = lv;
          var sv = window.sessionStorage.getItem(k);
          if (sv) dump['ss_' + k] = sv;
        }
        if (document.cookie) {
          dump['cookie'] = document.cookie;
        }
        // Also check if any key in localStorage contains eyJ
        for (var m = 0; m < window.localStorage.length; m++) {
          var lk = window.localStorage.key(m);
          if (lk) {
            var val = window.localStorage.getItem(lk);
            if (val && typeof val === 'string' && val.indexOf('eyJ') !== -1) {
              dump['ls_' + lk] = val;
            }
          }
        }
        for (var n = 0; n < window.sessionStorage.length; n++) {
          var sk = window.sessionStorage.key(n);
          if (sk) {
            var sval = window.sessionStorage.getItem(sk);
            if (sval && typeof sval === 'string' && sval.indexOf('eyJ') !== -1) {
              dump['ss_' + sk] = sval;
            }
          }
        }

        if (Object.keys(dump).length > 0) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'DHAN_PERIODIC_CHECK',
            payload: dump
          }));
        }
      } catch(e) {}
    }

    // Only start polling 2.5 seconds after page loads, and never on login page
    setTimeout(function() {
      setInterval(checkStorage, 2000);
    }, 2500);
  })();
  true;
`;

export function DhanWebLoginModal({ visible, onClose, onSuccess }: DhanWebLoginModalProps) {
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles();
  const [loading, setLoading] = useState(true);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [capturedData, setCapturedData] = useState<{ clientId: string; token: string; name: string } | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const capturedRef = useRef(false);
  const currentUrlRef = useRef('https://web.dhan.co/login');
  const webViewRef = useRef<WebView>(null);

  useEffect(() => {
    if (visible) {
      capturedRef.current = false;
      setIsCapturing(false);
      setIsConnected(false);
      setCapturedData(null);
      setShowDetails(false);
      setToastMessage(null);
      setLoading(true);
      currentUrlRef.current = 'https://web.dhan.co/login';
    }
    return () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
      }
    };
  }, [visible]);

  const showToast = (message: string) => {
    setToastMessage(message);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 2800);
  };

  const copyToClipboard = (text: string, label: string) => {
    if (!text) {
      showToast(`⚠️ No ${label} available to copy`);
      return;
    }
    if (webViewRef.current) {
      const escaped = JSON.stringify(text);
      webViewRef.current.injectJavaScript(`
        (function() {
          try {
            if (window.qStrategyCopyToClipboard) {
              window.qStrategyCopyToClipboard(${escaped});
            } else {
              var ta = document.createElement('textarea');
              ta.value = ${escaped};
              ta.style.position = 'fixed';
              ta.style.left = '-9999px';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.focus();
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
            }
          } catch(e) {}
        })();
        true;
      `);
    }
    Haptics.selectionAsync().catch(() => {});
    showToast(`✓ ${label} copied to clipboard!`);
  };

  const handleClose = () => {
    capturedRef.current = false;
    setIsCapturing(false);
    onClose();
  };

  const handleFreshLogin = () => {
    capturedRef.current = false;
    setIsCapturing(false);
    setIsConnected(false);
    setCapturedData(null);
    setShowDetails(false);
    setToastMessage(null);
    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(`
        (function() {
          try {
            window.localStorage.clear();
            window.sessionStorage.clear();
            var cookies = document.cookie.split(";");
            for (var i = 0; i < cookies.length; i++) {
              var cookie = cookies[i];
              var eqPos = cookie.indexOf("=");
              var name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
              document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
              document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.dhan.co";
            }
          } catch(e) {}
          window.location.href = 'https://web.dhan.co/login';
        })();
        true;
      `);
      setLoading(true);
    }
  };

  const handleMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      let creds: { clientId: string; token: string; name: string } | null = null;

      // Guard against auto-closing while the user is still on the login page!
      const currentUrl = (currentUrlRef.current || '').toLowerCase();
      const isOnLoginPage = currentUrl.includes('login') || currentUrl.includes('auth') || currentUrl.includes('signin');

      // Avoid passive background storage checks while user is actively typing login credentials
      if (
        isOnLoginPage &&
        data.type !== 'DHAN_STORAGE_DUMP' &&
        data.type !== 'DHAN_RAW_NETWORK_RESPONSE' &&
        data.type !== 'DHAN_LOGIN_SUCCESS'
      ) {
        return;
      }

      if (data.type === 'DHAN_LOGIN_SUCCESS' && data.payload?.token) {
        creds = {
          clientId: data.payload.clientId || '',
          token: data.payload.token,
          name: data.payload.name || 'Dhan Trader',
        };
      } else if (data.type === 'DHAN_RAW_NETWORK_RESPONSE' && data.body) {
        creds = tryExtractCredentials(data.body);
      } else if (data.type === 'DHAN_ENCRYPTED_STORAGE' && data.value) {
        creds = tryExtractCredentials(data.value);
      } else if (data.type === 'DHAN_PERIODIC_CHECK' && data.payload) {
        creds = tryExtractCredentials(data.payload);
      } else if (data.type === 'DHAN_STORAGE_DUMP' && data.payload) {
        const payload = data.payload;
        const ls = payload.localStorage || {};
        const ss = payload.sessionStorage || {};
        const cookie = payload.cookie || '';
        const url = payload.url || '';

        // 1. Scan cookie first (Dhan Web frequently sets session cookies)
        if (cookie) {
          creds = tryExtractCredentials(cookie);
        }

        // 2. Scan known localStorage & sessionStorage keys
        if (!creds) {
          creds =
            tryExtractCredentials(ls.JWTtoken) ||
            tryExtractCredentials(ls.userdata) ||
            tryExtractCredentials(ls.first_auth) ||
            tryExtractCredentials(ls.token) ||
            tryExtractCredentials(ls.TxnToken) ||
            tryExtractCredentials(ss.JWTtoken) ||
            tryExtractCredentials(ss.userdata) ||
            tryExtractCredentials(ss.token) ||
            tryExtractCredentials(ss.first_auth);
        }

        // 3. Scan all remaining localStorage keys
        if (!creds) {
          for (const key of Object.keys(ls)) {
            creds = tryExtractCredentials(ls[key]);
            if (creds) break;
          }
        }

        // 4. Scan all remaining sessionStorage keys
        if (!creds) {
          for (const key of Object.keys(ss)) {
            creds = tryExtractCredentials(ss[key]);
            if (creds) break;
          }
        }

        // 5. Check URL params
        if (!creds && url) {
          creds = tryExtractCredentials(url);
        }

        // 6. Deep serialized dump regex scan (catches any JWT anywhere in payload)
        if (!creds) {
          creds = tryExtractCredentials(JSON.stringify(payload));
        }

        // If manual capture still found nothing, alert user
        if (!creds) {
          Alert.alert(
            'Session Checking',
            'No Dhan login credentials found in active browser storage yet.\n\nPlease complete your Mobile number, Password, and OTP verification on the page first, then tap capture.'
          );
          return;
        }
      }

      if (creds && creds.token) {
        if (!capturedRef.current) {
          capturedRef.current = true;
          setIsCapturing(false);

          let clientId = creds.clientId?.trim();
          if (!clientId) {
            try {
              const existing = await secureVault.getCredentials();
              if (existing.clientId) {
                clientId = existing.clientId.trim();
              }
            } catch {}
          }
          clientId = clientId || '';
          const token = creds.token;
          const traderName = creds.name || 'Dhan Trader';

          // 1. Save credentials in hardware Keystore
          await secureVault.saveCredentials(clientId, token);
          await dhanDirectService.saveCredentials(clientId, token);

          // 2. Notify parent Settings screen
          onSuccess(clientId, token);

          // 3. Keep modal window OPEN - do not auto-close so user can view and copy data
          setIsConnected(true);
          setCapturedData({ clientId, token, name: traderName });

          // 4. In background, start live Dhan streamer and refresh store silently
          dhanHqFeedSocket.start();
          useRadarStore.getState().initStreamer();
          useRadarStore.getState().refreshAll(false);

          // 5. Fire success haptics and show toast notification
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          showToast('⚡ Live Stream Connected! Window kept open for inspection & copying.');
        } else if (creds.clientId && (!capturedData?.clientId || capturedData.clientId === '')) {
          setCapturedData((prev) => (prev ? { ...prev, clientId: creds!.clientId } : null));
          secureVault.saveCredentials(creds.clientId, creds.token).catch(() => {});
          dhanDirectService.saveCredentials(creds.clientId, creds.token).catch(() => {});
        }
      }
    } catch {
      // Ignored non-json web messages
    }
  };

  const handleManualForceCapture = () => {
    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(`
        (function() {
          try {
            var s = document.createElement('style');
            s.innerHTML = '.webmobile, app-mobilelanding { display: none !important; } .webpage { display: block !important; visibility: visible !important; }';
            (document.head || document.documentElement).appendChild(s);
          } catch(e) {}

          var dump = {
            url: window.location.href,
            cookie: '',
            localStorage: {},
            sessionStorage: {}
          };
          try {
            dump.cookie = document.cookie || '';
          } catch(e) {}
          try {
            for (var i = 0; i < window.localStorage.length; i++) {
              var k = window.localStorage.key(i);
              if (k) dump.localStorage[k] = window.localStorage.getItem(k);
            }
          } catch(e) {}
          try {
            for (var j = 0; j < window.sessionStorage.length; j++) {
              var sk = window.sessionStorage.key(j);
              if (sk) dump.sessionStorage[sk] = window.sessionStorage.getItem(sk);
            }
          } catch(e) {}

          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'DHAN_STORAGE_DUMP',
            payload: dump
          }));
        })();
        true;
      `);
    }
  };

  const handleReload = () => {
    if (webViewRef.current) {
      setLoading(true);
      webViewRef.current.reload();
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.surface} />

        {/* Top Header Bar */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={[styles.lockBadge, isConnected && styles.lockBadgeConnected]}>
              <Text style={styles.lockIcon}>{isConnected ? '⚡' : '🔒'}</Text>
            </View>
            <View>
              <Text style={styles.headerTitle}>
                {isConnected ? 'Dhan Web — Live Stream Active' : 'Dhan Web Official Portal'}
              </Text>
              <Text style={styles.headerSub}>
                {isConnected
                  ? `Connected as ${capturedData?.name || 'Trader'} • Data feed running`
                  : 'web.dhan.co • Auto-Token Interception'}
              </Text>
            </View>
          </View>

          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.freshLoginBtn}
              onPress={handleFreshLogin}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.7}
            >
              <Text style={styles.freshLoginBtnText}>🧹 Fresh Login</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconBtn} onPress={handleReload}>
              <Text style={styles.iconBtnText}>↻</Text>
            </TouchableOpacity>
            {isConnected ? (
              <TouchableOpacity
                testID="dhan-header-return-btn"
                style={styles.returnAppHeaderBtn}
                onPress={handleClose}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                activeOpacity={0.7}
              >
                <Text style={styles.returnAppHeaderBtnText}>✓ Return to App</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.closeBtn}
                onPress={handleClose}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                activeOpacity={0.7}
              >
                <Text style={styles.closeBtnText}>✕ Close</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Connected Success Banner or Security Trust Notice */}
        {isConnected ? (
          <View style={styles.connectedBanner}>
            <View style={styles.connectedBannerHeader}>
              <View style={styles.livePulseDot} />
              <View style={{ flex: 1 }}>
                <Text style={styles.connectedTitle}>⚡ Dhan Live Stream Connected & Synced</Text>
                <Text style={styles.connectedSub}>
                  Client ID: <Text style={{ fontWeight: '700', color: colors.bullish }}>{capturedData?.clientId || 'Synced'}</Text> • Trader: {capturedData?.name || 'Dhan Trader'}
                </Text>
              </View>
              <TouchableOpacity
                testID="dhan-banner-return-btn"
                style={styles.returnBannerBtn}
                onPress={handleClose}
                activeOpacity={0.7}
              >
                <Text style={styles.returnBannerBtnText}>✓ Return to App</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.actionChipsRow}>
              <TouchableOpacity
                testID="dhan-copy-token-btn"
                style={styles.actionChip}
                onPress={() => copyToClipboard(capturedData?.token || '', 'Access Token')}
                activeOpacity={0.7}
              >
                <Text style={styles.actionChipText}>📋 Copy Token</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="dhan-copy-clientid-btn"
                style={styles.actionChip}
                onPress={() => copyToClipboard(capturedData?.clientId || '', 'Client ID')}
                activeOpacity={0.7}
              >
                <Text style={styles.actionChipText}>📋 Copy Client ID</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="dhan-inspect-details-btn"
                style={[styles.actionChip, styles.actionChipSubtle]}
                onPress={() => setShowDetails(!showDetails)}
                activeOpacity={0.7}
              >
                <Text style={styles.actionChipSubtleText}>{showDetails ? '▲ Hide Details' : '🔍 Inspect Details'}</Text>
              </TouchableOpacity>
            </View>

            {showDetails && (
              <View style={styles.detailsContainer}>
                <View style={styles.detailsField}>
                  <Text style={styles.detailsFieldLabel}>CLIENT ID:</Text>
                  <TextInput
                    style={styles.detailsInput}
                    value={capturedData?.clientId || ''}
                    editable={false}
                    selectTextOnFocus={true}
                  />
                </View>
                <View style={styles.detailsField}>
                  <Text style={styles.detailsFieldLabel}>ACCESS TOKEN (JWT):</Text>
                  <TextInput
                    style={[styles.detailsInput, styles.detailsInputMultiline]}
                    value={capturedData?.token || ''}
                    editable={false}
                    selectTextOnFocus={true}
                    multiline={true}
                  />
                </View>
              </View>
            )}

            <Text style={styles.connectedNotice}>
              💡 Window stays open so you can view & copy web data. Text selection enabled. Tap 'Return to App' when done.
            </Text>
          </View>
        ) : (
          <View style={styles.securityBanner}>
            <Text style={styles.securityText}>
              🛡️ <Text style={{ fontWeight: '700' }}>Direct Official Login:</Text> You are logging directly into Dhan's official servers. Your password, OTP, and PIN remain strictly between you and Dhan. QStrategy only captures the resulting streaming session token.
            </Text>
          </View>
        )}

        {/* Embedded Official Dhan Web Terminal */}
        <View style={styles.webViewContainer}>
          <WebView
            ref={webViewRef}
            source={{ uri: 'https://web.dhan.co/login' }}
            userAgent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
            javaScriptEnabled={true}
            domStorageEnabled={true}
            sharedCookiesEnabled={true}
            injectedJavaScriptBeforeContentLoaded={DESKTOP_VIEWPORT_INJECTION}
            injectedJavaScript={INJECTED_TOKEN_INTERCEPTOR}
            scalesPageToFit={true}
            textInteractionEnabled={true}
            setSupportMultipleWindows={false}
            onNavigationStateChange={(navState) => {
              currentUrlRef.current = navState.url;
            }}
            onMessage={handleMessage}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
            style={styles.webView}
          />

          {loading && !isConnected && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color={colors.bullish} />
              <Text style={styles.loadingText}>Connecting to web.dhan.co...</Text>
            </View>
          )}

          {isCapturing && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color={colors.cyan} />
              <Text style={styles.loadingText}>Connecting Live Stream & Syncing...</Text>
            </View>
          )}

          {toastMessage && (
            <View style={styles.floatingToast} pointerEvents="none">
              <Text style={styles.floatingToastText}>{toastMessage}</Text>
            </View>
          )}
        </View>

        {/* Bottom Floating Bar */}
        <View style={styles.bottomBar}>
          {isConnected ? (
            <>
              <TouchableOpacity
                testID="dhan-bottom-copy-token-btn"
                style={styles.bottomCopyBtn}
                onPress={() => copyToClipboard(capturedData?.token || '', 'Access Token')}
                activeOpacity={0.7}
              >
                <Text style={styles.bottomCopyBtnText}>📋 Copy Token</Text>
              </TouchableOpacity>

              <TouchableOpacity
                testID="dhan-bottom-return-btn"
                style={styles.bottomReturnBtn}
                onPress={handleClose}
                activeOpacity={0.8}
              >
                <Text style={styles.bottomReturnBtnText}>✓ Return to App (Streaming Active)</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity
                style={styles.bottomCloseBtn}
                onPress={handleClose}
                activeOpacity={0.7}
              >
                <Text style={styles.bottomCloseBtnText}>✕ Close / Back</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.captureBtn}
                onPress={handleManualForceCapture}
                activeOpacity={0.8}
              >
                <Text style={styles.captureBtnText}>⚡ Finished Login? Tap to Capture</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const useThemedStyles = createThemedStyles((colors) => ({
  safeArea: {
    flex: 1,
    backgroundColor: colors.obsidian,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  lockBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.bullishSubtle,
    justifyContent: 'center',
    alignItems: 'center',
  },
  lockBadgeConnected: {
    backgroundColor: colors.bullishSubtle,
    borderWidth: 1,
    borderColor: colors.bullish,
  },
  lockIcon: {
    fontSize: 14,
  },
  headerTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  headerSub: {
    color: colors.textMuted,
    fontSize: 10,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  freshLoginBtn: {
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.warningSubtle,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  freshLoginBtnText: {
    color: colors.warning,
    fontSize: 11,
    fontWeight: '700',
  },
  iconBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  iconBtnText: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.bearishSubtle,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  closeBtnText: {
    color: colors.bearish,
    fontSize: 12,
    fontWeight: '700',
  },
  returnAppHeaderBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.bullishSubtle,
    borderWidth: 1,
    borderColor: colors.bullish,
  },
  returnAppHeaderBtnText: {
    color: colors.bullish,
    fontSize: 12,
    fontWeight: '700',
  },
  connectedBanner: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.bullish,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  connectedBannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  livePulseDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.bullish,
  },
  connectedTitle: {
    color: colors.bullish,
    fontSize: 12.5,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  connectedSub: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 1,
  },
  returnBannerBtn: {
    backgroundColor: colors.bullish,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
  },
  returnBannerBtnText: {
    color: '#FFFFFF',
    fontSize: 11.5,
    fontWeight: '700',
  },
  actionChipsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  actionChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  actionChipText: {
    color: colors.textPrimary,
    fontSize: 11,
    fontWeight: '600',
  },
  actionChipSubtle: {
    backgroundColor: 'transparent',
    borderColor: colors.divider,
  },
  actionChipSubtleText: {
    color: colors.cyan,
    fontSize: 11,
    fontWeight: '600',
  },
  detailsContainer: {
    backgroundColor: colors.obsidian,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 10,
    gap: 8,
    marginTop: 2,
  },
  detailsField: {
    gap: 4,
  },
  detailsFieldLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  detailsInput: {
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    fontSize: 11,
    fontFamily: 'monospace',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  detailsInputMultiline: {
    height: 60,
    textAlignVertical: 'top',
  },
  connectedNotice: {
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 14,
  },
  floatingToast: {
    position: 'absolute',
    top: 14,
    alignSelf: 'center',
    backgroundColor: 'rgba(20, 24, 33, 0.95)',
    borderWidth: 1,
    borderColor: colors.bullish,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    zIndex: 9999,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
  },
  floatingToastText: {
    color: colors.bullish,
    fontSize: 12,
    fontWeight: '700',
  },
  securityBanner: {
    backgroundColor: colors.bullishSubtle,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  securityText: {
    color: colors.textSecondary,
    fontSize: 10.5,
    lineHeight: 15,
  },
  webViewContainer: {
    flex: 1,
    position: 'relative',
    backgroundColor: colors.obsidian,
  },
  webView: {
    flex: 1,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
  bottomBar: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  bottomCopyBtn: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomCopyBtnText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  bottomReturnBtn: {
    flex: 1,
    backgroundColor: colors.bullish,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomReturnBtnText: {
    color: '#FFFFFF',
    fontSize: 12.5,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  bottomCloseBtn: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: colors.bearishSubtle,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomCloseBtnText: {
    color: colors.bearish,
    fontSize: 12,
    fontWeight: '700',
  },
  captureBtn: {
    flex: 1,
    backgroundColor: colors.bullish,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
}));
