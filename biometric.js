/**
 * Local WebAuthn lock for an already signed-in Supabase session.
 * The credential id lives only on this device. No server call.
 */
(function (global) {
  'use strict';

  var KEY = 'zohar_webauthn_v1';

  function readAll() {
    try {
      var parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function writeAll(data) {
    localStorage.setItem(KEY, JSON.stringify(data));
  }

  function bufferToB64url(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function b64urlToBuffer(value) {
    var text = String(value || '');
    var pad = text.length % 4 === 0 ? '' : '===='.slice(text.length % 4);
    var binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function mapError(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'AbortError') {
      return new Error('האימות בוטל או נכשל. אפשר לנסות שוב או להיכנס עם סיסמה.');
    }
    if (name === 'InvalidStateError') return new Error('כבר רשום אימות במכשיר הזה');
    if (name === 'NotSupportedError') return new Error('המכשיר לא תומך בכניסה ביומטרית');
    if (name === 'SecurityError') return new Error('הכניסה הביומטרית זמינה רק בחיבור מאובטח');
    return new Error('לא ניתן להפעיל את האימות הביומטרי');
  }

  async function available() {
    if (!global.isSecureContext) return false;
    if (!global.PublicKeyCredential || !navigator.credentials) return false;
    if (typeof navigator.credentials.create !== 'function' || typeof navigator.credentials.get !== 'function') return false;
    if (typeof global.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false;
    try {
      return await global.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() === true;
    } catch (err) {
      return false;
    }
  }

  function enabled(userId) {
    var row = readAll()[String(userId || '')];
    return !!(row && row.credentialId);
  }

  function clear(userId) {
    var all = readAll();
    delete all[String(userId || '')];
    writeAll(all);
  }

  async function register(user) {
    if (!user || !user.id) throw new Error('אין הרשאה לבצע את הפעולה');
    if (!await available()) throw new Error('המכשיר לא תומך בכניסה ביומטרית');
    var userId = new TextEncoder().encode(String(user.id));
    if (userId.length > 64) userId = userId.slice(0, 64);
    var credential;
    try {
      credential = await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: 'לידים – זוהר' },
          user: {
            id: userId,
            name: String(user.username || user.id),
            displayName: String(user.name || user.username || 'משתמש')
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 }
          ],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
            residentKey: 'preferred'
          },
          timeout: 60000,
          attestation: 'none'
        }
      });
    } catch (err) {
      throw mapError(err);
    }
    if (!credential || !credential.rawId) throw new Error('לא ניתן להפעיל את האימות הביומטרי');
    var all = readAll();
    all[String(user.id)] = { credentialId: bufferToB64url(credential.rawId) };
    writeAll(all);
  }

  async function verify(userId) {
    var row = readAll()[String(userId || '')];
    if (!row || !row.credentialId) throw new Error('האימות הביומטרי לא מופעל');
    var assertion;
    try {
      assertion = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          timeout: 60000,
          userVerification: 'required',
          allowCredentials: [{
            type: 'public-key',
            id: b64urlToBuffer(row.credentialId),
            transports: ['internal']
          }]
        }
      });
    } catch (err) {
      throw mapError(err);
    }
    if (!assertion) throw new Error('האימות בוטל או נכשל. אפשר לנסות שוב או להיכנס עם סיסמה.');
    return true;
  }

  global.ZoharBiometric = {
    available: available,
    enabled: enabled,
    clear: clear,
    register: register,
    verify: verify
  };
})(window);
