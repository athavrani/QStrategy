// QStrategy — Dhan Web In-App Login & Instant Token Sync Modal

import React, { useState, useRef, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
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
import { colors } from '../../theme/colors';
import { dhanPlainStorage } from '../../services/dhanPlainStorage';
import { dhanDirectService } from '../../services/dhanDirectService';
import { dhanWebStreamer } from '../../services/dhanWebStreamer';
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
  const [loading, setLoading] = useState(true);
  const [isCapturing, setIsCapturing] = useState(false);
  const capturedRef = useRef(false);
  const currentUrlRef = useRef('https://web.dhan.co/login');
  const webViewRef = useRef<WebView>(null);

  useEffect(() => {
    if (visible) {
      capturedRef.current = false;
      setIsCapturing(false);
      setLoading(true);
      currentUrlRef.current = 'https://web.dhan.co/login';
    }
  }, [visible]);

  const handleClose = () => {
    capturedRef.current = false;
    setIsCapturing(false);
    onClose();
  };

  const handleFreshLogin = () => {
    capturedRef.current = false;
    setIsCapturing(false);
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

      if (data.type !== 'DHAN_STORAGE_DUMP' && isOnLoginPage) {
        // User is still entering mobile number, OTP, or PIN. Do not auto-dismiss!
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

      if (creds && creds.token && !capturedRef.current) {
        capturedRef.current = true;
        setIsCapturing(true);

        let clientId = creds.clientId?.trim();
        if (!clientId) {
          try {
            const existing = await dhanPlainStorage.load();
            if (existing.clientId) {
              clientId = existing.clientId.trim();
            }
          } catch {}
        }
        clientId = clientId || '';
        const token = creds.token;
        const traderName = creds.name || 'Dhan Trader';

        // 1. Immediately save plain-text credentials in storage
        await dhanPlainStorage.save(clientId, token);
        await dhanDirectService.saveCredentials(clientId, token);

        // 2. Notify parent Settings screen
        onSuccess(clientId, token);

        // 3. Dismiss modal IMMEDIATELY so user is smoothly returned to app with zero lag
        setIsCapturing(false);
        onClose();

        // 4. In background, start live Dhan streamer and refresh store silently
        dhanWebStreamer.start();
        useRadarStore.getState().initStreamer();
        useRadarStore.getState().refreshAll(false);

        // 5. Fire success haptics and show clean notification on parent screen
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setTimeout(() => {
          Alert.alert(
            '⚡ Dhan Live Stream Connected!',
            `Welcome, ${traderName}!\n\nClient ID: ${clientId}\nToken captured successfully.\n\nLive real-time market streaming is now active on all screens.`
          );
        }, 350);
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
        <StatusBar barStyle="light-content" backgroundColor="#0A111C" />

        {/* Top Header Bar */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={styles.lockBadge}>
              <Text style={styles.lockIcon}>🔒</Text>
            </View>
            <View>
              <Text style={styles.headerTitle}>Dhan Web Official Portal</Text>
              <Text style={styles.headerSub}>web.dhan.co • Auto-Token Interception</Text>
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
            <TouchableOpacity
              style={styles.closeBtn}
              onPress={handleClose}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              activeOpacity={0.7}
            >
              <Text style={styles.closeBtnText}>✕ Close</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Security Trust Notice */}
        <View style={styles.securityBanner}>
          <Text style={styles.securityText}>
            🛡️ <Text style={{ fontWeight: '700' }}>Direct Official Login:</Text> You are logging directly into Dhan's official servers. Your password, OTP, and PIN remain strictly between you and Dhan. QStrategy only captures the resulting streaming session token.
          </Text>
        </View>

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
            setSupportMultipleWindows={false}
            onNavigationStateChange={(navState) => {
              currentUrlRef.current = navState.url;
            }}
            onMessage={handleMessage}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
            style={styles.webView}
          />

          {loading && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color={colors.bullish} />
              <Text style={styles.loadingText}>Connecting to web.dhan.co...</Text>
            </View>
          )}

          {isCapturing && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color={colors.cyan} />
              <Text style={styles.loadingText}>Connecting Live Stream & Returning to App...</Text>
            </View>
          )}
        </View>

        {/* Bottom Floating Bar with Dual Action: Quick Close + Force Capture */}
        <View style={styles.bottomBar}>
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
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#070D18',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
    backgroundColor: '#0A111C',
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
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  lockIcon: {
    fontSize: 14,
  },
  headerTitle: {
    color: '#FFFFFF',
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
    backgroundColor: 'rgba(234, 179, 8, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(234, 179, 8, 0.35)',
  },
  freshLoginBtnText: {
    color: '#EAB308',
    fontSize: 11,
    fontWeight: '700',
  },
  iconBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  iconBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  closeBtnText: {
    color: colors.bearish,
    fontSize: 12,
    fontWeight: '700',
  },
  securityBanner: {
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(16, 185, 129, 0.15)',
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
    backgroundColor: '#FFFFFF',
  },
  webView: {
    flex: 1,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(7, 13, 24, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  bottomBar: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#0A111C',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  bottomCloseBtn: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
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
});
