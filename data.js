/**
 * ZoharData — the only module that reads or writes CRM data.
 *
 * Users, leads, finance and history live in Supabase (Auth + RLS).
 * localStorage is used only for the one-time device import of old leads
 * and for the auth session that supabase-js keeps itself.
 *
 * Methods: init, login, logout, session, listLeads, listUsers,
 * saveLead, saveEvent, deleteLead, saveUser, deleteUser,
 * changeOwnPassword, importCsv, exportCsv, hasDeviceLeads, importDeviceLeads, onChange.
 */
(function (global) {
  'use strict';

  var URL = 'https://ofxlvnjflcuyqvnlxted.supabase.co';
  var KEY = 'sb_publishable_86lf34rTzykeHtfd-LQCQw_HnlyTwoq';
  var ADMIN_USERS = URL + '/functions/v1/admin-users';
  var STATUSES = ['open', 'closed', 'not-closed', 'cancelled'];
  var USERNAME = /^[a-z0-9._-]{3,32}$/;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  var HEADER_ALIASES = {
    name: ['שם', 'name', 'full name', 'full_name', 'שם מלא'],
    phone: ['טלפון', 'phone', 'phone number', 'mobile', 'נייד', 'פלאפון'],
    email: ['אימייל', 'email', 'e-mail', 'דוא"ל', 'דואל'],
    source: ['מקור', 'source', 'campaign', 'קמפיין'],
    notes: ['הערות', 'notes'],
    rabbanit: ['רבנית', 'rabbanit'],
    cost: ['עלות', 'cost'],
    status: ['סטטוס', 'status'],
    eventDate: ['תאריך חוג', 'event date', 'eventdate'],
    classClosed: ['נסגר חוג בית', 'נסגר חוג', 'class closed'],
    standingOrders: ['הוראות קבע', 'standing orders'],
    cash: ['מזומן', 'cash'],
    orderStatus: ['סטטוס קבע', 'order status'],
    monthlyAmount: ['סכום חודשי', 'monthly'],
    oneTime: ['תרומה חד-פעמית', 'תרומה', 'one time'],
    eventCost: ['עלות חוג', 'event cost'],
    orderStart: ['תאריך התחלת הוראת קבע', 'order start']
  };

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
    listeners.forEach(function (fn) {
      try { fn(); } catch (err) {}
    });
  }

  function scheduleNotify() {
    if (!profile) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(notify, 400);
  }

  function translate(error) {
    var status = error && (error.status || error.statusCode || error.code);
    var message = String(error && (error.message || error.details || error.hint) || '');
    if (status === 401 || status === 403 || status === '42501' || error && error.code === '42501' || /permission|row-level security|not authorized|jwt|forbidden/i.test(message)) {
      return new Error('אין הרשאה לבצע את הפעולה');
    }
    if (/failed to fetch|network|offline/i.test(message)) return new Error('אין חיבור לשרת');
    return new Error('הפעולה נכשלה');
  }

  function requireUser() {
    if (!profile) throw new Error('אין הרשאה לבצע את הפעולה');
  }

  function requireAdmin() {
    if (!profile || profile.role !== 'admin') throw new Error('אין הרשאה לבצע את הפעולה');
  }

  function validUsername(value) {
    return USERNAME.test(String(value || '').trim().toLowerCase());
  }

  function validPassword(value) {
    var text = String(value || '');
    return text.length >= 8 && text.length <= 72;
  }

  function num(value, fallback) {
    if (value === undefined || value === null || value === '') {
      var fallbackNumber = Number(fallback);
      return Number.isFinite(fallbackNumber) ? fallbackNumber : 0;
    }
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function dateOrNull(value) {
    var text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
    return text.slice(0, 10);
  }

  function phoneKey(phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 7) return '';
    return digits.length > 9 ? digits.slice(-9) : digits;
  }

  function publicUser(row) {
    return {
      id: row.id || row.user_id,
      username: row.username,
      name: row.display_name || row.name || row.username,
      role: row.role,
      rabbanitName: row.rabbanit_name || '',
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
      rabbanitName: profile.rabbanitName || ''
    };
  }

  async function loadProfile(userId) {
    var res = await client.from('profiles').select('id, username, display_name, role, rabbanit_name').eq('id', userId).single();
    if (res.error || !res.data) {
      profile = null;
      throw new Error('הפרופיל לא נמצא');
    }
    profile = publicUser(res.data);
  }

  function historyOf(row) {
    var list = Array.isArray(row.lead_history) ? row.lead_history.slice() : [];
    list.sort(function (a, b) { return String(a.created_at || '').localeCompare(String(b.created_at || '')); });
    return list.map(function (item) {
      var when = item.created_at ? new Date(item.created_at) : null;
      return {
        date: when && !isNaN(when.getTime()) ? when.toLocaleString('he-IL') : '',
        user: item.user_name || '',
        change: item.change || ''
      };
    });
  }

  function financeOf(row) {
    var finance = row.lead_finance;
    if (Array.isArray(finance)) finance = finance[0];
    return finance || {};
  }

  function projectLead(row, role) {
    var finance = role === 'admin' ? financeOf(row) : {};
    var closed = row.home_class_closed === true || row.status === 'closed';
    var lead = {
      id: row.id,
      name: row.name || '',
      phone: row.phone || '',
      email: row.email || '',
      source: row.source || '',
      status: row.status || 'open',
      classClosed: closed,
      rabbanit: row.assigned_rabbanit_id || '',
      eventDate: row.event_date || '',
      notes: row.notes || '',
      createdAt: row.created_at || '',
      standingOrders: num(row.standing_orders, 0),
      cash: num(row.cash, 0),
      orderStatus: row.order_status || ''
    };
    if (role === 'admin') {
      lead.cost = num(finance.cost, 0);
      lead.eventCost = num(finance.event_cost, 0);
      lead.oneTime = num(finance.one_time, 0);
      lead.monthlyAmount = num(finance.monthly_amount, 0);
      lead.orderStart = finance.order_start || '';
      lead.history = historyOf(row);
    } else if (role === 'rabbanit') {
      lead.history = historyOf(row);
      delete lead.standingOrders;
      delete lead.cash;
      delete lead.orderStatus;
    } else {
      delete lead.email;
      delete lead.source;
      delete lead.notes;
      delete lead.createdAt;
    }
    return lead;
  }

  function matchRabbanit(value, profiles) {
    var text = String(value || '').trim();
    if (!text) return null;
    if (UUID.test(text)) return text;
    var lower = text.toLowerCase();
    var found = (profiles || []).find(function (person) {
      return person.role === 'rabbanit' && (person.id === text || person.username === lower || person.name === text || person.rabbanitName === text);
    });
    return found ? found.id : null;
  }

  function payloadFrom(input, profiles) {
    var status = STATUSES.indexOf(input.status) >= 0 ? input.status : 'open';
    var closed = input.classClosed === true || input.classClosed === 'yes' || input.classClosed === 'כן';
    var opened = input.classClosed === false || input.classClosed === 'no' || input.classClosed === 'לא';
    if (closed) status = 'closed';
    else if (opened && status === 'closed') status = 'open';
    var order = input.orderStatus == null ? '' : String(input.orderStatus);
    if (['active', 'inactive', 'pending'].indexOf(order) < 0) order = '';
    var assigned = profiles ? matchRabbanit(input.rabbanit, profiles) : (function () {
      var text = String(input.rabbanit || '').trim();
      if (!text) return null;
      if (!UUID.test(text)) throw new Error('בחרו רבנית מהרשימה');
      return text;
    })();
    return {
      name: String(input.name || '').trim(),
      phone: String(input.phone || '').trim(),
      email: String(input.email || '').trim() || null,
      source: String(input.source || '').trim(),
      status: status,
      standing_orders: Math.max(0, Math.round(num(input.standingOrders, 0))),
      order_status: order || null,
      cash: Math.max(0, num(input.cash, 0)),
      event_date: dateOrNull(input.eventDate),
      assigned_rabbanit_id: assigned,
      notes: String(input.notes == null ? '' : input.notes)
    };
  }

  function financeFrom(input) {
    return {
      cost: num(input.cost, 0),
      event_cost: num(input.eventCost, 0),
      one_time: num(input.oneTime, 0),
      monthly_amount: num(input.monthlyAmount, 0),
      order_start: dateOrNull(input.orderStart)
    };
  }

  async function syncFinance(leadId, finance) {
    var updated = await client.from('lead_finance').update(finance).eq('lead_id', leadId).select('lead_id');
    if (updated.error) throw translate(updated.error);
    if (updated.data && updated.data.length) return;
    var inserted = await client.from('lead_finance').upsert(Object.assign({ lead_id: leadId }, finance), { onConflict: 'lead_id' });
    if (inserted.error) throw translate(inserted.error);
  }

  async function accessToken() {
    var res = await client.auth.getSession();
    var session = res.data && res.data.session;
    if (!session || !session.access_token) throw new Error('אין הרשאה לבצע את הפעולה');
    return session.access_token;
  }

  async function adminUsers(body) {
    var token = await accessToken();
    var response;
    try {
      response = await fetch(ADMIN_USERS, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: KEY,
          Authorization: 'Bearer ' + token
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw new Error('אין חיבור לשרת');
    }
    var payload = null;
    try { payload = await response.json(); } catch (err) { payload = null; }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('אין הרשאה לבצע את הפעולה');
      var message = payload && (payload.message || payload.error || payload.msg);
      if (typeof message === 'string' && message) throw new Error(message);
      throw new Error('הפעולה נכשלה');
    }
    return payload || {};
  }

  function normHeader(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function headerIndex(headers, aliases) {
    for (var i = 0; i < aliases.length; i++) {
      var idx = headers.indexOf(normHeader(aliases[i]));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  function cell(headers, row, key) {
    var idx = headerIndex(headers, HEADER_ALIASES[key]);
    if (idx < 0) return '';
    return String(row[idx] == null ? '' : row[idx]).trim();
  }

  function mapStatus(value) {
    var raw = String(value || '').trim();
    var lower = raw.toLowerCase();
    if (lower === 'open' || raw === 'פתוח') return 'open';
    if (lower === 'closed' || raw === 'נסגר' || raw === 'נסגר חוג בית') return 'closed';
    if (lower === 'not-closed' || raw === 'לא נסגר') return 'not-closed';
    if (lower === 'cancelled' || lower === 'canceled' || raw === 'ביטל') return 'cancelled';
    return 'open';
  }

  function mapClosed(value) {
    var raw = String(value || '').trim();
    var lower = raw.toLowerCase();
    return raw === 'כן' || lower === 'yes' || lower === 'true' || lower === '1' || lower === 'y';
  }

  function mapOrderStatus(value) {
    var raw = String(value || '').trim();
    var lower = raw.toLowerCase();
    if (lower === 'active' || raw === 'פעילה' || raw === 'פעיל') return 'active';
    if (lower === 'inactive' || raw === 'לא פעילה') return 'inactive';
    if (lower === 'pending' || raw === 'ממתינה') return 'pending';
    return '';
  }

  function detectRabbanit(source) {
    var text = String(source || '');
    if (text.indexOf('שרה') >= 0) return 'שרה';
    if (text.indexOf('רבקה') >= 0) return 'רבקה';
    if (text.indexOf('לאה') >= 0) return 'לאה';
    return '';
  }

  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = '';
    var quoted = false;
    var source = String(text || '').replace(/^\uFEFF/, '');
    for (var i = 0; i < source.length; i++) {
      var ch = source[i];
      if (quoted) {
        if (ch === '"') {
          if (source[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch !== '\r') field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (cells) {
      return cells.some(function (item) { return String(item).trim() !== ''; });
    });
  }

  function csvEscape(value) {
    var text = String(value == null ? '' : value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }

  function knownHeaderSet() {
    var set = Object.create(null);
    Object.keys(HEADER_ALIASES).forEach(function (key) {
      HEADER_ALIASES[key].forEach(function (alias) { set[normHeader(alias)] = true; });
    });
    return set;
  }

  function recordFromRow(row, headers) {
    if (!headers) {
      return {
        name: String(row[0] || '').trim(),
        phone: String(row[1] || '').trim(),
        email: String(row[2] || '').trim(),
        source: String(row[3] || '').trim(),
        notes: '',
        rabbanit: detectRabbanit(row[3]),
        cost: 0,
        status: 'open',
        classClosed: false,
        eventDate: '',
        standingOrders: 0,
        cash: 0,
        orderStatus: '',
        monthlyAmount: 0,
        oneTime: 0,
        eventCost: 0,
        orderStart: ''
      };
    }
    var source = cell(headers, row, 'source');
    var status = mapStatus(cell(headers, row, 'status'));
    var hasClosed = headerIndex(headers, HEADER_ALIASES.classClosed) >= 0;
    return {
      name: cell(headers, row, 'name'),
      phone: cell(headers, row, 'phone'),
      email: cell(headers, row, 'email'),
      source: source,
      notes: cell(headers, row, 'notes'),
      rabbanit: cell(headers, row, 'rabbanit') || detectRabbanit(source),
      cost: num(cell(headers, row, 'cost'), 0),
      status: status,
      classClosed: hasClosed ? mapClosed(cell(headers, row, 'classClosed')) : status === 'closed',
      eventDate: cell(headers, row, 'eventDate'),
      standingOrders: num(cell(headers, row, 'standingOrders'), 0),
      cash: num(cell(headers, row, 'cash'), 0),
      orderStatus: mapOrderStatus(cell(headers, row, 'orderStatus')),
      monthlyAmount: num(cell(headers, row, 'monthlyAmount'), 0),
      oneTime: num(cell(headers, row, 'oneTime'), 0),
      eventCost: num(cell(headers, row, 'eventCost'), 0),
      orderStart: cell(headers, row, 'orderStart')
    };
  }

  async function insertLead(input, profiles) {
    if (!String(input.name || '').trim()) throw new Error('מלאו את השדות החובה');
    var row = payloadFrom(input, profiles || null);
    var inserted = await client.from('leads').insert(row).select('id').single();
    if (inserted.error) throw translate(inserted.error);
    if (profile.role === 'admin') await syncFinance(inserted.data.id, financeFrom(input));
    return inserted.data.id;
  }

  function readDeviceLeads() {
    try {
      var raw = localStorage.getItem('zohar_leads');
      if (!raw) return [];
      var data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      return [];
    }
  }

  function clearDeviceCrm() {
    try {
      localStorage.removeItem('zohar_leads');
      localStorage.removeItem('zohar_users');
    } catch (err) {}
  }

  function listenForChanges() {
    window.addEventListener('focus', scheduleNotify);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') scheduleNotify();
    });
    client.channel('zohar-crm')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, scheduleNotify)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lead_finance' }, scheduleNotify)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lead_history' }, scheduleNotify)
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
      client.auth.onAuthStateChange(function (event) {
        if (event === 'SIGNED_OUT') profile = null;
      });
      listenForChanges();
    })();
    return ready;
  }

  async function login(username, password) {
    await init();
    var name = String(username || '').trim().toLowerCase();
    if (!validUsername(name)) throw new Error('שם המשתמש חייב להיות באנגלית (אותיות, מספרים, נקודה, מקף או קו תחתון, 3–32 תווים)');
    if (!password) throw new Error('הזינו סיסמה');
    var res = await client.auth.signInWithPassword({ email: name + '@zohar.local', password: String(password) });
    if (res.error || !res.data || !res.data.user) throw new Error('שם משתמש או סיסמה שגויים');
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

  async function listLeads() {
    await init();
    requireUser();
    var columns = profile.role === 'activist'
      ? 'id,name,phone,status,standing_orders,cash,event_date,assigned_rabbanit_id,home_class_closed'
      : (profile.role === 'rabbanit'
        ? 'id,name,phone,email,source,status,event_date,assigned_rabbanit_id,notes,created_at,home_class_closed'
        : 'id,name,phone,email,source,status,standing_orders,order_status,cash,event_date,assigned_rabbanit_id,notes,created_at,home_class_closed');
    var res = await client.from('leads').select(columns).order('created_at', { ascending: false });
    if (res.error && columns.indexOf('home_class_closed') >= 0) {
      res = await client.from('leads').select(columns.replace(',home_class_closed', '')).order('created_at', { ascending: false });
    }
    if (res.error) throw translate(res.error);
    var rows = res.data || [];
    if ((profile.role === 'admin' || profile.role === 'rabbanit') && rows.length) {
      var ids = rows.map(function (row) { return row.id; });
      if (profile.role === 'admin') {
        var fin = await client.from('lead_finance').select('lead_id,cost,event_cost,one_time,monthly_amount,order_start').in('lead_id', ids);
        if (fin.error) throw translate(fin.error);
        var finMap = {};
        (fin.data || []).forEach(function (row) { finMap[row.lead_id] = row; });
        rows.forEach(function (row) { row.lead_finance = finMap[row.id]; });
      }
      var hist = await client.from('lead_history').select('lead_id,user_name,change,created_at').in('lead_id', ids);
      if (!hist.error) {
        var histMap = {};
        (hist.data || []).forEach(function (row) {
          if (!histMap[row.lead_id]) histMap[row.lead_id] = [];
          histMap[row.lead_id].push(row);
        });
        rows.forEach(function (row) { row.lead_history = histMap[row.id] || []; });
      }
    }
    return rows.map(function (row) { return projectLead(row, profile.role); });
  }

  function userRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.users)) return payload.users;
    if (payload && Array.isArray(payload.data)) return payload.data;
    return [];
  }

  async function listUsers() {
    await init();
    requireUser();
    if (profile.role === 'rabbanit') return [];
    if (profile.role === 'admin') {
      var listed = await adminUsers({ action: 'list' });
      return userRows(listed).map(publicUser).sort(function (a, b) {
        return String(a.name || '').localeCompare(String(b.name || ''), 'he');
      });
    }
    var res = await client.from('profiles').select('id, username, display_name, role, rabbanit_name, active').eq('role', 'rabbanit');
    if (res.error) {
      res = await client.from('profiles').select('id, username, display_name, role, rabbanit_name').eq('role', 'rabbanit');
    }
    if (res.error) throw translate(res.error);
    return (res.data || []).map(publicUser).filter(function (user) { return user.active !== false; });
  }

  function saveLead(input) {
    return enqueue(async function () {
      await init();
      requireUser();
      input = input || {};
      if (profile.role === 'rabbanit') {
        if (!input.id) throw new Error('אין הרשאה לבצע את הפעולה');
        var closed = input.classClosed === true || input.classClosed === 'yes' || input.classClosed === 'כן';
        var rpc = await client.rpc('set_home_class_closed', { p_lead_id: input.id, p_closed: closed });
        if (rpc.error) throw translate(rpc.error);
        return;
      }
      if (profile.role !== 'admin') throw new Error('אין הרשאה לבצע את הפעולה');
      if (input.id) {
        var row = payloadFrom(input, null);
        var updated = await client.from('leads').update(row).eq('id', input.id).select('id');
        if (updated.error) throw translate(updated.error);
        if (!updated.data || !updated.data.length) throw new Error('הליד לא נמצא');
        await syncFinance(input.id, financeFrom(input));
        return;
      }
      await insertLead(input, null);
    });
  }

  function saveEvent(id, patch) {
    return enqueue(async function () {
      await init();
      if (!profile || profile.role !== 'activist') throw new Error('אין הרשאה לבצע את הפעולה');
      var orders = Number(patch && patch.standingOrders);
      var cash = Number(patch && patch.cash);
      if (!Number.isFinite(orders) || orders < 0) throw new Error('מספר הוראות הקבע אינו תקין');
      if (!Number.isFinite(cash) || cash < 0) throw new Error('סכום המזומן אינו תקין');
      var assigned = String(patch && patch.rabbanit || '').trim();
      if (assigned && !UUID.test(assigned)) throw new Error('בחרו רבנית מהרשימה');
      var res = await client.from('leads').update({
        standing_orders: Math.round(orders),
        cash: cash,
        assigned_rabbanit_id: assigned || null
      }).eq('id', id).select('id');
      if (res.error) throw translate(res.error);
      if (!res.data || !res.data.length) throw new Error('האירוע לא נמצא');
    });
  }

  function deleteLead(id) {
    return enqueue(async function () {
      await init();
      requireAdmin();
      var res = await client.from('leads').delete().eq('id', id).select('id');
      if (res.error) throw translate(res.error);
      if (!res.data || !res.data.length) throw new Error('הליד לא נמצא');
    });
  }

  function saveUser(input) {
    return enqueue(async function () {
      await init();
      requireAdmin();
      var username = String(input && input.username || '').trim().toLowerCase();
      var name = String(input && input.name || '').trim();
      var allowedRoles = { admin: true, activist: true, rabbanit: true };
      var role = input && allowedRoles[input.role] ? input.role : '';
      var password = input && input.password ? String(input.password) : '';
      var rabbanitName = String(input && input.rabbanitName || '').trim();
      var active = !(input && input.active === false);
      if (!validUsername(username)) throw new Error('שם המשתמש חייב להיות באנגלית (אותיות, מספרים, נקודה, מקף או קו תחתון, 3–32 תווים)');
      if (!name || !role) throw new Error('מלאו את השדות החובה');
      if (role === 'rabbanit' && !rabbanitName) throw new Error('מלאו את שם הרבנית');
      if (input && input.create) {
        if (!validPassword(password)) throw new Error('הסיסמה חייבת להיות באורך 8 עד 72 תווים');
        await adminUsers({
          action: 'create',
          username: username,
          password: password,
          display_name: name,
          role: role,
          active: active,
          rabbanit_name: role === 'rabbanit' ? rabbanitName : undefined
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
        active: active,
        rabbanit_name: role === 'rabbanit' ? rabbanitName : null
      };
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
      requireAdmin();
      if (!userId) throw new Error('המשתמש לא נמצא');
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

  function importRecords(records) {
    return enqueue(async function () {
      await init();
      requireAdmin();
      var profiles = await listUsers();
      var existing = await client.from('leads').select('phone');
      if (existing.error) throw translate(existing.error);
      var seen = Object.create(null);
      (existing.data || []).forEach(function (lead) {
        var key = phoneKey(lead.phone);
        if (key) seen[key] = true;
      });
      var added = 0;
      var skipped = 0;
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        if (!record || !String(record.name || '').trim()) continue;
        var key = phoneKey(record.phone);
        if (key && seen[key]) { skipped++; continue; }
        if (key) seen[key] = true;
        record.rabbanit = matchRabbanit(record.rabbanit, profiles) || '';
        await insertLead(record, profiles);
        added++;
      }
      return { added: added, skipped: skipped };
    });
  }

  function importCsv(text) {
    var table = parseCsv(text);
    if (!table.length) return Promise.resolve({ added: 0, skipped: 0 });
    var known = knownHeaderSet();
    var first = table[0].map(normHeader);
    var hasHeader = first.some(function (item) { return known[item]; });
    var headers = hasHeader ? first : null;
    var data = hasHeader ? table.slice(1) : table;
    return importRecords(data.map(function (row) { return recordFromRow(row, headers); }));
  }

  async function exportCsv() {
    await init();
    if (!profile || (profile.role !== 'admin' && profile.role !== 'rabbanit')) throw new Error('אין הרשאה לבצע את הפעולה');
    var leads = await listLeads();
    var profiles = profile.role === 'admin' ? await listUsers() : [];
    function rabbanitName(id) {
      var person = profiles.find(function (item) { return item.id === id; });
      if (person) return person.name || person.username;
      if (profile.role === 'rabbanit' && id === profile.id) return profile.name;
      return '';
    }
    function statusLabel(status) {
      return { open: 'פתוח', closed: 'נסגר', 'not-closed': 'לא נסגר', cancelled: 'ביטל' }[status] || status || '';
    }
    function orderLabel(status) {
      return { active: 'פעילה', inactive: 'לא פעילה', pending: 'ממתינה' }[status] || '';
    }
    var header;
    var lines;
    if (profile.role === 'admin') {
      header = ['שם', 'טלפון', 'אימייל', 'מקור', 'עלות', 'סטטוס', 'נסגר חוג בית', 'הוראות קבע', 'מזומן', 'סטטוס קבע', 'סכום חודשי', 'תרומה חד-פעמית', 'עלות חוג', 'תאריך התחלת הוראת קבע', 'רבנית', 'תאריך חוג', 'הערות'];
      lines = leads.map(function (lead) {
        return [lead.name, lead.phone, lead.email, lead.source, lead.cost, statusLabel(lead.status), lead.classClosed ? 'כן' : 'לא', lead.standingOrders, lead.cash, orderLabel(lead.orderStatus), lead.monthlyAmount, lead.oneTime, lead.eventCost, lead.orderStart, rabbanitName(lead.rabbanit), lead.eventDate, lead.notes];
      });
    } else {
      header = ['שם', 'טלפון', 'אימייל', 'מקור', 'סטטוס', 'נסגר חוג בית', 'רבנית', 'תאריך חוג', 'הערות'];
      lines = leads.map(function (lead) {
        return [lead.name, lead.phone, lead.email, lead.source, statusLabel(lead.status), lead.classClosed ? 'כן' : 'לא', rabbanitName(lead.rabbanit), lead.eventDate, lead.notes];
      });
    }
    return '\uFEFF' + [header].concat(lines).map(function (row) {
      return row.map(csvEscape).join(',');
    }).join('\n');
  }

  function hasDeviceLeads() {
    return readDeviceLeads().length > 0;
  }

  function importDeviceLeads() {
    var records = readDeviceLeads().map(function (lead) {
      var status = STATUSES.indexOf(lead.status) >= 0 ? lead.status : 'open';
      if (lead.classClosed === true) status = 'closed';
      return {
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        source: lead.source,
        notes: lead.notes,
        status: status,
        classClosed: status === 'closed',
        rabbanit: lead.rabbanit,
        eventDate: lead.eventDate,
        standingOrders: lead.standingOrders,
        cash: lead.cash,
        orderStatus: lead.orderStatus,
        cost: lead.cost,
        monthlyAmount: lead.monthlyAmount,
        oneTime: lead.oneTime,
        eventCost: lead.eventCost,
        orderStart: lead.orderStart
      };
    });
    return importRecords(records).then(function (result) {
      clearDeviceCrm();
      return result;
    });
  }

  global.ZoharData = {
    init: init,
    login: login,
    logout: logout,
    session: currentSession,
    listLeads: listLeads,
    listUsers: listUsers,
    saveLead: saveLead,
    saveEvent: saveEvent,
    deleteLead: deleteLead,
    saveUser: saveUser,
    deleteUser: deleteUser,
    changeOwnPassword: changeOwnPassword,
    importCsv: importCsv,
    exportCsv: exportCsv,
    hasDeviceLeads: hasDeviceLeads,
    importDeviceLeads: importDeviceLeads,
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };
})(window);
