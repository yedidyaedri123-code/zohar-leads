/**
 * ZoharData — Supabase only. Leads, home-class closings, events,
 * rabbaniyot and users. No local CRM cache except the auth session
 * supabase-js keeps itself.
 */
(function (global) {
  'use strict';

  var URL = 'https://ofxlvnjflcuyqvnlxted.supabase.co';
  var KEY = 'sb_publishable_86lf34rTzykeHtfd-LQCQw_HnlyTwoq';
  var ADMIN_USERS = URL + '/functions/v1/admin-users';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var ASCII_USERNAME = /^[a-z0-9._-]{3,32}$/;
  var UNICODE_USERNAME = /^[\p{L}\p{N}._-]+(?: [\p{L}\p{N}._-]+)*$/u;

  var client = null;
  var profile = null;
  var ready = null;
  var chain = Promise.resolve();
  var listeners = [];
  var refreshTimer = null;

  function enqueue(task) {
    var run = chain.then(function () { return task(); });
    chain = run.then(function () {}, function () {});
    return run;
  }

  function notify() {
    listeners.forEach(function (fn) { try { fn(); } catch (err) {} });
  }

  function scheduleNotify() {
    if (!profile) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(notify, 400);
  }

  function translate(error) {
    var message = String(error && (error.message || error.details || '') || '');
    var status = error && (error.status || error.code);
    if (status === 401 || status === 403 || status === '42501' || /row-level security|permission denied/i.test(message)) {
      return new Error('אין הרשאה לבצע את הפעולה');
    }
    if (/jwt expired|invalid jwt/i.test(message)) return new Error('פג תוקף ההתחברות. היכנסו שוב.');
    if (/failed to fetch|network|offline/i.test(message)) return new Error('אין חיבור לשרת');
    if (message) return new Error(message);
    return new Error('הפעולה נכשלה');
  }

  function requireUser() {
    if (!profile) throw new Error('אין הרשאה לבצע את הפעולה');
  }

  async function requireAdmin() {
    var session = await refreshIdentity();
    if (!session || !session.access_token) throw new Error('פג תוקף ההתחברות. היכנסו שוב.');
    if (profile && profile.role && profile.role !== 'admin') throw new Error('אין הרשאה לבצע את הפעולה');
  }

  function normalizeUsername(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  // Same rule as supabase/functions/admin-users/index.ts.
  // A plain ASCII name stays "<name>@zohar.local". A space or any
  // non-ASCII character becomes "u" + lowercase hex of the UTF-8 bytes.
  // 31 bytes is the longest that fits: "u" + 62 hex chars = 63, under the
  // 64-character email local-part limit.
  function emailLocal(username) {
    if (ASCII_USERNAME.test(username)) return username;
    var needsHex = / /.test(username) || /[^\u0000-\u007F]/.test(username);
    if (!needsHex || !UNICODE_USERNAME.test(username)) return '';
    var bytes = new TextEncoder().encode(username);
    if (bytes.length > 31) return '';
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return 'u' + hex;
  }

  function usernameError(value) {
    var name = normalizeUsername(value);
    if (!name) return 'הזינו שם משתמש';
    if (emailLocal(name)) return '';
    var needsHex = / /.test(name) || /[^\u0000-\u007F]/.test(name);
    if (needsHex && UNICODE_USERNAME.test(name) && new TextEncoder().encode(name).length > 31) return 'שם המשתמש ארוך מדי';
    return 'שם המשתמש יכול להיות בעברית או באנגלית, עם רווח בין מילים. באנגלית בלי רווח: 3–32 תווים (אותיות, מספרים, נקודה, מקף או קו תחתון).';
  }

  function loginEmail(value) {
    var local = emailLocal(normalizeUsername(value));
    return local ? local + '@zohar.local' : '';
  }

  function validPassword(value) {
    var text = String(value || '');
    return text.length >= 8 && text.length <= 72;
  }

  function num(value, fallback) {
    if (value === undefined || value === null || value === '') {
      var n = Number(fallback);
      return Number.isFinite(n) ? n : 0;
    }
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function dateOrNull(value) {
    var text = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
  }

  function isoOrNull(value) {
    if (!value) return null;
    var date = new Date(value);
    return isNaN(date.getTime()) ? null : date.toISOString();
  }

  function edgeError(response, payload) {
    var code = String(payload && (payload.error || payload.code || payload.message) || '');
    var messages = {
      username_taken: 'שם המשתמש כבר תפוס',
      invalid_username: 'שם המשתמש יכול להיות בעברית או באנגלית, עם רווח בין מילים. באנגלית בלי רווח: 3–32 תווים (אותיות, מספרים, נקודה, מקף או קו תחתון).',
      rabbaniya_id_required: 'לא ניתן ליצור את הרבנית. נסו שוב.',
      rabbaniya_name_taken: 'כבר קיימת רבנית בשם הזה',
      rabbaniya_already_linked: 'הרבנית הזו כבר משויכת למשתמש אחר',
      rabbaniya_not_found: 'הרבנית לא נמצאה',
      cannot_change_own_role: 'אי אפשר לשנות את התפקיד של עצמך',
      cannot_disable_self: 'אי אפשר להשבית את החשבון של עצמך',
      cannot_delete_self: 'אי אפשר למחוק את המשתמש המחובר',
      user_banned: 'החשבון הזה מושבת. פנו למנהל.'
    };
    if (messages[code]) return new Error(messages[code]);
    if (response.status === 401 || response.status === 403) return new Error('אין הרשאה לבצע את הפעולה');
    var detail = payload && (payload.message || payload.msg || payload.details || payload.error);
    if (detail && String(detail) !== code) return new Error(String(detail));
    if (detail && String(detail) === code) return new Error(String(detail));
    return new Error('הפעולה נכשלה');
  }

  function publicUser(row) {
    return {
      id: row.id || row.user_id,
      username: row.username || '',
      name: row.display_name || row.name || row.username || '',
      role: row.role || '',
      rabbaniyaId: row.rabbaniya_id || '',
      active: row.active !== false,
      createdAt: row.created_at || ''
    };
  }

  function currentSession() {
    if (!profile) return null;
    return {
      id: profile.id,
      username: profile.username,
      name: profile.name,
      role: profile.role,
      rabbaniyaId: profile.rabbaniyaId || ''
    };
  }

  function joinedName(row) {
    var rel = row.rabbaniyot;
    if (Array.isArray(rel)) rel = rel[0];
    return rel && rel.name || '';
  }

  function projectLead(row) {
    return {
      id: row.id,
      name: row.name || '',
      city: row.city || '',
      phone: row.phone || '',
      rabbanit: row.rabbanit_ref || '',
      rabbanitName: joinedName(row),
      closerId: row.closer_id || '',
      status: row.status === 'closed' ? 'closed' : 'not_closed',
      notes: row.notes || '',
      createdAt: row.created_at || ''
    };
  }

  function projectClass(row) {
    return {
      id: row.id,
      leadId: row.lead_id || '',
      city: row.city || '',
      street: row.street || '',
      houseNumber: row.house_number || '',
      phone: row.phone || '',
      rabbanit: row.rabbanit_ref || '',
      rabbanitName: joinedName(row),
      closerId: row.closer_id || '',
      closedOn: row.closed_on || '',
      eventAt: row.event_at || ''
    };
  }

  function projectEvent(row, finance) {
    return {
      id: row.id,
      homeClassId: row.home_class_id || '',
      phone: row.phone || '',
      city: row.city || '',
      street: row.street || '',
      houseNumber: row.house_number || '',
      eventAt: row.event_at || '',
      rabbanit: row.rabbanit_ref || '',
      rabbanitName: joinedName(row),
      fundraiser: row.fundraiser || '',
      standingOrders: num(row.standing_orders, 0),
      cash: num(row.cash, 0),
      status: row.status === 'did_not_happen' ? 'did_not_happen' : 'held',
      activistId: row.activist_id || '',
      cost: num(finance && finance.cost, 0),
      eventCost: num(finance && finance.event_cost, 0),
      oneTime: num(finance && finance.one_time, 0),
      monthlyAmount: num(finance && finance.monthly_amount, 0),
      orderStart: finance && finance.order_start || ''
    };
  }

  async function loadProfile(userId) {
    var res = await client.from('profiles').select('id, username, display_name, role').eq('id', userId).single();
    if (res.error || !res.data) {
      profile = null;
      throw new Error('הפרופיל לא נמצא');
    }
    profile = publicUser(res.data);
  }

  function sessionFresh(session) {
    if (!session || !session.access_token) return false;
    if (!session.expires_at) return true;
    return session.expires_at * 1000 > Date.now() + 60000;
  }

  async function currentAuthSession() {
    var session = null;
    try {
      var res = await client.auth.getSession();
      session = res.data && res.data.session;
    } catch (err) {}
    if (sessionFresh(session)) return session;
    try {
      var refreshed = await client.auth.refreshSession();
      var next = refreshed.data && refreshed.data.session;
      if (next && next.access_token) return next;
    } catch (err) {}
    if (session && session.access_token) return session;
    return null;
  }

  async function refreshIdentity() {
    await init();
    var session = await currentAuthSession();
    if (session && session.user && (!profile || profile.id !== session.user.id)) {
      try { await loadProfile(session.user.id); } catch (err) {}
    }
    return session;
  }

  async function accessToken() {
    var session = await currentAuthSession();
    if (!session || !session.access_token) throw new Error('פג תוקף ההתחברות. היכנסו שוב.');
    return session.access_token;
  }

  async function adminUsers(body) {
    var token = await accessToken();
    var response;
    try {
      response = await fetch(ADMIN_USERS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + token },
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw new Error('אין חיבור לשרת');
    }
    var payload = null;
    try { payload = await response.json(); } catch (err) { payload = null; }
    if (!response.ok) throw edgeError(response, payload);
    return payload || {};
  }

  function userRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.users)) return payload.users;
    if (payload && Array.isArray(payload.data)) return payload.data;
    return [];
  }

  function listenForChanges() {
    window.addEventListener('focus', scheduleNotify);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') scheduleNotify();
    });
    client.channel('zohar-crm')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, scheduleNotify)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'home_classes' }, scheduleNotify)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, scheduleNotify)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event_finance' }, scheduleNotify)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rabbaniyot' }, scheduleNotify)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, scheduleNotify)
      .subscribe();
  }

  async function init() {
    if (ready) return ready;
    ready = (async function () {
      if (!global.supabase || typeof global.supabase.createClient !== 'function') {
        throw new Error('לא ניתן לטעון את החיבור לשרת');
      }
      client = global.supabase.createClient(URL, KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
      var sessionRes = await client.auth.getSession();
      var session = sessionRes.data && sessionRes.data.session;
      if (session) {
        try { await loadProfile(session.user.id); }
        catch (err) {
          profile = null;
          await client.auth.signOut();
        }
      }
      client.auth.onAuthStateChange(function (event, session) {
        if (event === 'SIGNED_OUT' && !session) profile = null;
        if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session && session.user) {
          if (!profile || profile.id !== session.user.id) {
            loadProfile(session.user.id).catch(function () {});
          }
        }
      });
      listenForChanges();
    })();
    return ready;
  }

  async function login(username, password) {
    await init();
    var name = normalizeUsername(username);
    var email = loginEmail(name);
    var nameError = usernameError(name);
    if (nameError) throw new Error(nameError);
    if (!password) throw new Error('הזינו סיסמה');
    var res = await client.auth.signInWithPassword({ email: email, password: String(password) });
    if (res.error || !res.data || !res.data.user) {
      var code = res.error && (res.error.code || res.error.message || '');
      if (code === 'user_banned' || /user_banned/i.test(String(code))) throw new Error('החשבון הזה מושבת. פנו למנהל.');
      throw new Error('שם משתמש או סיסמה שגויים');
    }
    try {
      await loadProfile(res.data.user.id);
    } catch (err) {
      await client.auth.signOut();
      profile = null;
      throw err;
    }
    return currentSession();
  }

  async function logout() {
    await init();
    profile = null;
    await client.auth.signOut();
  }

  async function listRabbaniyot() {
    await init();
    requireUser();
    var res = await client.from('rabbaniyot').select('id,name,active,profile_id,created_at').order('name');
    if (res.error) throw translate(res.error);
    return (res.data || []).map(function (row) {
      return { id: row.id, name: row.name || '', active: row.active !== false, profileId: row.profile_id || '', createdAt: row.created_at || '' };
    });
  }

  function saveRabbaniya(input) {
    return enqueue(async function () {
      await init();
      await requireAdmin();
      var name = String(input && input.name || '').trim();
      if (!name) throw new Error('מלאו את שם הרבנית');
      var active = !(input && input.active === false);
      if (input && input.create) {
        var inserted = await client.from('rabbaniyot').insert({ name: name, active: active }).select('id').single();
        if (inserted.error) {
          if (inserted.error.code === '23505' || /duplicate|unique/i.test(inserted.error.message || '')) throw new Error('שם הרבנית כבר קיים');
          throw translate(inserted.error);
        }
        return;
      }
      var updated = await client.from('rabbaniyot').update({ name: name, active: active }).eq('id', input.id).select('id');
      if (updated.error) {
        if (updated.error.code === '23505' || /duplicate|unique/i.test(updated.error.message || '')) throw new Error('שם הרבנית כבר קיים');
        throw translate(updated.error);
      }
      if (!updated.data || !updated.data.length) throw new Error('הרבנית לא נמצאה');
    });
  }

  function deleteRabbaniya(id) {
    return enqueue(async function () {
      await init();
      await requireAdmin();
      var res = await client.from('rabbaniyot').delete().eq('id', id).select('id');
      if (res.error) throw translate(res.error);
      if (!res.data || !res.data.length) throw new Error('הרבנית לא נמצאה');
    });
  }

  async function listUsers() {
    await init();
    requireUser();
    if (profile.role === 'admin') {
      var listed = await adminUsers({ action: 'list' });
      return userRows(listed).map(publicUser).sort(function (a, b) {
        return String(a.name || '').localeCompare(String(b.name || ''), 'he');
      });
    }
    var res = await client.from('profiles').select('id,display_name,role');
    if (res.error) return [];
    return (res.data || []).map(function (row) {
      return { id: row.id, name: row.display_name || '', role: row.role || '', username: '', rabbaniyaId: '', active: true, createdAt: '' };
    });
  }

  function saveUser(input) {
    return enqueue(async function () {
      await init();
      await requireAdmin();
      var username = normalizeUsername(input && input.username);
      var name = String(input && input.name || '').trim();
      var allowed = { admin: true, activist: true, rabbanit: true, call_center: true };
      var role = input && allowed[input.role] ? input.role : '';
      var password = input && input.password ? String(input.password) : '';
      var active = !(input && input.active === false);
      var nameError = usernameError(username);
      if (nameError) throw new Error(nameError);
      if (!name || !role) throw new Error('מלאו את השדות החובה');
      if (input && input.create) {
        if (!validPassword(password)) throw new Error('הסיסמה חייבת להיות באורך 8 עד 72 תווים');
        await adminUsers({
          action: 'create',
          username: username,
          password: password,
          display_name: name,
          role: role,
          active: active
        });
        return;
      }
      if (!input || !input.id) throw new Error('המשתמש לא נמצא');
      var body = {
        action: 'update',
        user_id: input.id,
        username: username,
        display_name: name,
        role: role,
        active: active
      };
      if (role !== 'rabbanit') body.rabbaniya_id = null;
      if (password) {
        if (!validPassword(password)) throw new Error('הסיסמה חייבת להיות באורך 8 עד 72 תווים');
        body.password = password;
      }
      await adminUsers(body);
    });
  }

  function deleteUser(userId) {
    return enqueue(async function () {
      await init();
      await requireAdmin();
      await adminUsers({ action: 'delete', user_id: userId });
    });
  }

  async function changeOwnPassword(password) {
    await init();
    requireUser();
    if (!validPassword(password)) throw new Error('הסיסמה חייבת להיות באורך 8 עד 72 תווים');
    var res = await client.auth.updateUser({ password: String(password) });
    if (res.error) throw translate(res.error);
  }

  function leadColumns() {
    return 'id,name,city,phone,rabbanit_ref,closer_id,status,notes,created_at,rabbaniyot(name)';
  }

  async function listLeads() {
    await init();
    requireUser();
    if (profile.role === 'activist') return [];
    var res = await client.from('leads').select(leadColumns()).order('created_at', { ascending: false });
    if (res.error) throw translate(res.error);
    return (res.data || []).map(projectLead);
  }

  function leadPayload(input, mode) {
    var status = input.status === 'closed' ? 'closed' : 'not_closed';
    var body = {
      name: String(input.name || '').trim(),
      city: String(input.city || '').trim(),
      phone: String(input.phone || '').trim(),
      status: status,
      notes: String(input.notes || '')
    };
    if (!body.name) throw new Error('מלאו את השם');
    if (profile.role === 'admin' || (profile.role === 'call_center' && mode !== 'skip-ref')) {
      var ref = String(input.rabbanit || '').trim();
      body.rabbanit_ref = UUID.test(ref) ? ref : null;
    }
    if (profile.role === 'admin') {
      var closer = String(input.closerId || '').trim();
      if (UUID.test(closer)) body.closer_id = closer;
    }
    if (profile.role === 'rabbanit') delete body.rabbanit_ref;
    return body;
  }

  function saveLead(input) {
    return enqueue(async function () {
      await init();
      requireUser();
      if (profile.role === 'activist') throw new Error('אין הרשאה לבצע את הפעולה');
      input = input || {};
      if (input.id) {
        var body = leadPayload(input);
        if (profile.role !== 'admin') delete body.closer_id;
        if (profile.role === 'rabbanit') delete body.rabbanit_ref;
        var updated = await client.from('leads').update(body).eq('id', input.id).select('id');
        if (updated.error) throw translate(updated.error);
        if (!updated.data || !updated.data.length) throw new Error('הליד לא נמצא');
        return;
      }
      var created = leadPayload(input);
      if (profile.role !== 'admin') delete created.closer_id;
      if (profile.role === 'rabbanit') delete created.rabbanit_ref;
      var inserted = await client.from('leads').insert(created).select('id').single();
      if (inserted.error) throw translate(inserted.error);
    });
  }

  function deleteLead(id) {
    return enqueue(async function () {
      await init();
      await requireAdmin();
      var res = await client.from('leads').delete().eq('id', id).select('id');
      if (res.error) throw translate(res.error);
      if (!res.data || !res.data.length) throw new Error('הליד לא נמצא');
    });
  }

  async function listHomeClasses() {
    await init();
    requireUser();
    if (profile.role === 'activist') return [];
    var res = await client.from('home_classes').select('id,lead_id,city,street,house_number,phone,rabbanit_ref,closer_id,closed_on,event_at,rabbaniyot(name)').order('event_at', { ascending: false });
    if (res.error) throw translate(res.error);
    return (res.data || []).map(projectClass);
  }

  function classPayload(input) {
    var ref = String(input.rabbanit || '').trim();
    var body = {
      lead_id: UUID.test(String(input.leadId || '')) ? input.leadId : null,
      city: String(input.city || '').trim(),
      street: String(input.street || '').trim(),
      house_number: String(input.houseNumber || '').trim(),
      phone: String(input.phone || '').trim(),
      closed_on: dateOrNull(input.closedOn) || new Date().toISOString().slice(0, 10),
      event_at: isoOrNull(input.eventAt)
    };
    if (!body.city || !body.phone) throw new Error('מלאו עיר וטלפון');
    if (!body.event_at) throw new Error('מלאו תאריך ושעת האירוע');
    if (profile.role === 'admin' || profile.role === 'call_center') {
      body.rabbanit_ref = UUID.test(ref) ? ref : null;
    }
    if (profile.role === 'admin') {
      var closer = String(input.closerId || '').trim();
      if (UUID.test(closer)) body.closer_id = closer;
    }
    return body;
  }

  function saveHomeClass(input) {
    return enqueue(async function () {
      await init();
      requireUser();
      if (profile.role === 'activist') throw new Error('אין הרשאה לבצע את הפעולה');
      input = input || {};
      var body = classPayload(input);
      if (profile.role === 'rabbanit') delete body.rabbanit_ref;
      if (profile.role !== 'admin') delete body.closer_id;
      if (input.id) {
        var updated = await client.from('home_classes').update(body).eq('id', input.id).select('id');
        if (updated.error) throw translate(updated.error);
        if (!updated.data || !updated.data.length) throw new Error('הסגירה לא נמצאה');
        return;
      }
      var inserted = await client.from('home_classes').insert(body).select('id').single();
      if (inserted.error) throw translate(inserted.error);
    });
  }

  function deleteHomeClass(id) {
    return enqueue(async function () {
      await init();
      await requireAdmin();
      var res = await client.from('home_classes').delete().eq('id', id).select('id');
      if (res.error) throw translate(res.error);
      if (!res.data || !res.data.length) throw new Error('הסגירה לא נמצאה');
    });
  }

  async function listEvents() {
    await init();
    requireUser();
    if (profile.role === 'call_center') return [];
    var res = await client.from('events').select('id,home_class_id,phone,city,street,house_number,event_at,rabbanit_ref,rabbanit_ref_manual,fundraiser,standing_orders,cash,status,activist_id,rabbaniyot(name)').order('event_at', { ascending: false });
    if (res.error && /rabbanit_ref_manual/.test(res.error.message || '')) {
      res = await client.from('events').select('id,home_class_id,phone,city,street,house_number,event_at,rabbanit_ref,fundraiser,standing_orders,cash,status,activist_id,rabbaniyot(name)').order('event_at', { ascending: false });
    }
    if (res.error) throw translate(res.error);
    var rows = res.data || [];
    var finance = {};
    if (profile.role === 'admin' && rows.length) {
      var fin = await client.from('event_finance').select('event_id,cost,event_cost,one_time,monthly_amount,order_start').in('event_id', rows.map(function (row) { return row.id; }));
      if (!fin.error) (fin.data || []).forEach(function (row) { finance[row.event_id] = row; });
    }
    return rows.map(function (row) { return projectEvent(row, finance[row.id]); });
  }

  function eventEntry(input) {
    var ref = String(input.rabbanit || '').trim();
    return {
      fundraiser: String(input.fundraiser || '').trim(),
      standing_orders: Math.max(0, Math.round(num(input.standingOrders, 0))),
      cash: Math.max(0, num(input.cash, 0)),
      status: input.didNotHappen || input.status === 'did_not_happen' ? 'did_not_happen' : 'held',
      rabbanit_ref: UUID.test(ref) ? ref : null,
      rabbanit_ref_manual: true
    };
  }

  function saveEvent(input) {
    return enqueue(async function () {
      await init();
      requireUser();
      if (profile.role === 'call_center') throw new Error('אין הרשאה לבצע את הפעולה');
      input = input || {};
      var body = eventEntry(input);
      if (profile.role === 'admin') {
        var activist = String(input.activistId || '').trim();
        body.activist_id = UUID.test(activist) ? activist : null;
        if (!input.homeClassId) {
          body.phone = String(input.phone || '').trim();
          body.city = String(input.city || '').trim();
          body.street = String(input.street || '').trim();
          body.house_number = String(input.houseNumber || '').trim();
          body.event_at = isoOrNull(input.eventAt);
        }
      }
      if (input.id) {
        var updated = await client.from('events').update(body).eq('id', input.id).select('id');
        if (updated.error && /rabbanit_ref_manual/.test(updated.error.message || '')) {
          delete body.rabbanit_ref_manual;
          updated = await client.from('events').update(body).eq('id', input.id).select('id');
        }
        if (updated.error) throw translate(updated.error);
        if (!updated.data || !updated.data.length) throw new Error('האירוע לא נמצא');
        if (profile.role === 'admin') await syncEventFinance(input.id, input);
        return;
      }
      if (profile.role !== 'admin') throw new Error('אין הרשאה לבצע את הפעולה');
      var inserted = await client.from('events').insert(body).select('id').single();
      if (inserted.error && /rabbanit_ref_manual/.test(inserted.error.message || '')) {
        delete body.rabbanit_ref_manual;
        inserted = await client.from('events').insert(body).select('id').single();
      }
      if (inserted.error) throw translate(inserted.error);
      await syncEventFinance(inserted.data.id, input);
    });
  }

  async function syncEventFinance(eventId, input) {
    var finance = {
      cost: num(input.cost, 0),
      event_cost: num(input.eventCost, 0),
      one_time: num(input.oneTime, 0),
      monthly_amount: num(input.monthlyAmount, 0),
      order_start: dateOrNull(input.orderStart)
    };
    var updated = await client.from('event_finance').update(finance).eq('event_id', eventId).select('event_id');
    if (updated.error) throw translate(updated.error);
    if (updated.data && updated.data.length) return;
    var inserted = await client.from('event_finance').upsert(Object.assign({ event_id: eventId }, finance), { onConflict: 'event_id' });
    if (inserted.error) throw translate(inserted.error);
  }

  function deleteEvent(id) {
    return enqueue(async function () {
      await init();
      await requireAdmin();
      var res = await client.from('events').delete().eq('id', id).select('id');
      if (res.error) throw translate(res.error);
      if (!res.data || !res.data.length) throw new Error('האירוע לא נמצא');
    });
  }

  global.ZoharData = {
    init: init,
    login: login,
    logout: logout,
    session: currentSession,
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    listRabbaniyot: listRabbaniyot,
    saveRabbaniya: saveRabbaniya,
    deleteRabbaniya: deleteRabbaniya,
    listUsers: listUsers,
    saveUser: saveUser,
    deleteUser: deleteUser,
    changeOwnPassword: changeOwnPassword,
    listLeads: listLeads,
    saveLead: saveLead,
    deleteLead: deleteLead,
    listHomeClasses: listHomeClasses,
    saveHomeClass: saveHomeClass,
    deleteHomeClass: deleteHomeClass,
    listEvents: listEvents,
    saveEvent: saveEvent,
    deleteEvent: deleteEvent
  };
})(window);
