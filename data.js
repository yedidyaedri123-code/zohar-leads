/**
 * ZoharData — the only module that reads or writes CRM data.
 *
 * This build stores leads and users in localStorage and hashes passwords
 * with SHA-256 (Web Crypto). The UI must call these methods and must not
 * touch localStorage itself.
 *
 * To move to Supabase, replace this file and keep the same methods:
 *   init, login, logout, session, listLeads, listUsers,
 *   saveLead, saveEvent, deleteLead, saveUser, deleteUser,
 *   changePassword, importCsv, exportCsv.
 * Supabase Auth + RLS will then enforce access on the server. The checks
 * in this file are client-side only.
 */
(function (global) {
  'use strict';

  var LEADS_KEY = 'zohar_leads';
  var USERS_KEY = 'zohar_users';
  var STATUSES = ['open', 'closed', 'not-closed', 'cancelled'];
  var ORDER_STATUSES = ['', 'active', 'inactive', 'pending'];

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

  var session = null;
  var ready = null;
  var chain = Promise.resolve();

  function enqueue(task) {
    var run = chain.then(function () { return task(); });
    chain = run.then(function () {}, function () {});
    return run;
  }

  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw == null || raw === '') return fallback;
      var value = JSON.parse(raw);
      return value == null ? fallback : value;
    } catch (err) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      throw new Error('לא ניתן לשמור את הנתונים בדפדפן');
    }
  }

  function newId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function sha256(text) {
    if (!global.crypto || !global.crypto.subtle) {
      return Promise.reject(new Error('הדפדפן לא תומך בהצפנת סיסמה'));
    }
    var data = new TextEncoder().encode(String(text));
    return global.crypto.subtle.digest('SHA-256', data).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    });
  }

  function safeEqual(a, b) {
    var left = String(a || '');
    var right = String(b || '');
    if (left.length !== right.length) return false;
    var diff = 0;
    for (var i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
    return diff === 0;
  }

  function normalizeRole(role) {
    var raw = String(role || '').trim();
    var lower = raw.toLowerCase();
    if (lower === 'admin' || raw === 'מנהל') return 'admin';
    if (lower === 'operator' || lower === 'activist' || raw === 'פעיל') return 'operator';
    if (lower === 'rabbanit' || lower === 'employee' || raw === 'רבנית') return 'rabbanit';
    return 'unknown';
  }

  function validUsername(name) {
    if (typeof name !== 'string') return false;
    var trimmed = name.trim();
    if (!trimmed || trimmed.length > 80) return false;
    if (trimmed === '__proto__' || trimmed === 'prototype' || trimmed === 'constructor') return false;
    return !/[\u0000-\u001f<>]/.test(trimmed);
  }

  function isReservedUsername(name) {
    var trimmed = String(name || '').trim();
    return trimmed.toLowerCase() === 'admin' || trimmed === 'מנהל';
  }

  function loadUsers() {
    var raw = loadJSON(USERS_KEY, null);
    var users = Object.create(null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return users;
    Object.keys(raw).forEach(function (key) {
      if (!validUsername(key)) return;
      var row = raw[key];
      if (!row || typeof row !== 'object') return;
      users[key] = {
        passHash: typeof row.passHash === 'string' ? row.passHash : '',
        pass: row.pass,
        name: String(row.name || key),
        role: normalizeRole(row.role),
        rabbanit: String(row.rabbanit || '')
      };
    });
    return users;
  }

  function saveUsers(users) {
    var plain = {};
    Object.keys(users).forEach(function (key) {
      var row = users[key];
      plain[key] = {
        passHash: row.passHash || '',
        name: row.name || key,
        role: row.role || 'unknown',
        rabbanit: row.rabbanit || ''
      };
    });
    saveJSON(USERS_KEY, plain);
  }

  function loadLeads() {
    var raw = loadJSON(LEADS_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (row) {
      return row && typeof row === 'object' && !Array.isArray(row);
    }).map(function (row) {
      return Object.assign({}, row);
    });
  }

  function saveLeads(leads) {
    saveJSON(LEADS_KEY, leads);
  }

  function resolveRabbanit(value, users) {
    var text = String(value || '').trim();
    if (!text) return '';
    if (users[text] && users[text].role === 'rabbanit') return text;
    var found = Object.keys(users).find(function (key) {
      var user = users[key];
      return user && user.role === 'rabbanit' && (user.name === text || String(user.rabbanit || '') === text || key === text);
    });
    return found || text;
  }

  function relinkLeads(users, leads) {
    var changed = false;
    leads.forEach(function (lead) {
      var next = resolveRabbanit(lead.rabbanit, users);
      if (next !== lead.rabbanit) {
        lead.rabbanit = next;
        changed = true;
      }
    });
    return changed;
  }

  function cleanHistory(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(-200).map(function (item) {
      return {
        date: String(item && item.date || ''),
        user: String(item && item.user || ''),
        change: String(item && item.change || '')
      };
    });
  }

  function str(value, fallback) {
    if (value === undefined || value === null) return fallback == null ? '' : String(fallback);
    return String(value);
  }

  function num(value, fallback) {
    if (value === undefined || value === null || value === '') {
      var fallbackNumber = Number(fallback);
      return Number.isFinite(fallbackNumber) ? fallbackNumber : 0;
    }
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function pickEnum(value, allowed, fallback) {
    var text = value == null ? '' : String(value);
    if (allowed.indexOf(text) >= 0) return text;
    if (allowed.indexOf(fallback) >= 0) return fallback;
    return allowed[0];
  }

  function sanitizeAssignment(value, previous, users) {
    var text = String(value == null ? '' : value).trim();
    if (!text) return '';
    if (users[text] && users[text].role === 'rabbanit') return text;
    if (previous != null && text === String(previous)) return String(previous);
    var resolved = resolveRabbanit(text, users);
    if (users[resolved] && users[resolved].role === 'rabbanit') return resolved;
    return previous ? String(previous) : '';
  }

  function asClosed(value) {
    return value === true || value === 'yes' || value === 'כן' || value === 1 || value === '1';
  }

  function projectLead(lead, role) {
    var closed = !!lead.classClosed;
    if (role === 'operator') {
      return {
        id: String(lead.id),
        name: String(lead.name || ''),
        phone: String(lead.phone || ''),
        eventDate: String(lead.eventDate || ''),
        rabbanit: String(lead.rabbanit || ''),
        standingOrders: num(lead.standingOrders, 0),
        cash: num(lead.cash, 0),
        classClosed: closed
      };
    }
    var shared = {
      id: String(lead.id),
      name: String(lead.name || ''),
      phone: String(lead.phone || ''),
      email: String(lead.email || ''),
      source: String(lead.source || ''),
      status: String(lead.status || 'open'),
      classClosed: closed,
      rabbanit: String(lead.rabbanit || ''),
      eventDate: String(lead.eventDate || ''),
      notes: String(lead.notes || ''),
      createdAt: lead.createdAt || ''
    };
    if (role !== 'admin') return shared;
    shared.cost = num(lead.cost, 0);
    shared.standingOrders = num(lead.standingOrders, 0);
    shared.cash = num(lead.cash, 0);
    shared.orderStatus = String(lead.orderStatus || '');
    shared.monthlyAmount = num(lead.monthlyAmount, 0);
    shared.orderStart = String(lead.orderStart || '');
    shared.oneTime = num(lead.oneTime, 0);
    shared.eventCost = num(lead.eventCost, 0);
    shared.history = cleanHistory(lead.history);
    return shared;
  }

  function leadsForSession(leads) {
    if (!session) return [];
    if (session.role === 'admin') return leads.map(function (lead) { return projectLead(lead, 'admin'); });
    if (session.role === 'rabbanit') {
      return leads.filter(function (lead) { return lead.rabbanit === session.username; })
        .map(function (lead) { return projectLead(lead, 'rabbanit'); });
    }
    if (session.role === 'operator') {
      return leads.filter(function (lead) { return String(lead.eventDate || '').trim(); })
        .map(function (lead) { return projectLead(lead, 'operator'); });
    }
    return [];
  }

  function requireAdmin() {
    if (!session || session.role !== 'admin') throw new Error('אין הרשאה');
  }

  function publicUsers(users) {
    return Object.keys(users).map(function (key) {
      return { username: key, name: users[key].name || key, role: users[key].role };
    }).sort(function (a, b) { return a.name.localeCompare(b.name, 'he'); });
  }

  async function migrate() {
    var users = loadUsers();
    for (var i = 0; i < Object.keys(users).length; i++) {
      var key = Object.keys(users)[i];
      var user = users[key];
      if (user.pass && !user.passHash) user.passHash = await sha256(String(user.pass));
      delete user.pass;
    }
    if (!users['מנהל']) {
      users['מנהל'] = { passHash: await sha256('מנהל123'), name: 'מנהל', role: 'admin', rabbanit: '' };
    } else {
      users['מנהל'].role = 'admin';
      if (!users['מנהל'].name) users['מנהל'].name = 'מנהל';
      if (!users['מנהל'].passHash) users['מנהל'].passHash = await sha256('מנהל123');
    }
    if (!users['פעיל']) {
      users['פעיל'] = { passHash: await sha256('פעיל123'), name: 'פעיל', role: 'operator', rabbanit: '' };
    }
    if (users['מפעילה']) delete users['מפעילה'];

    var leads = loadLeads();
    var seen = Object.create(null);
    leads.forEach(function (lead) {
      var id = lead.id == null || lead.id === '' ? '' : String(lead.id);
      if (!id || seen[id]) id = newId();
      seen[id] = true;
      lead.id = id;
      if (typeof lead.classClosed !== 'boolean') lead.classClosed = lead.status === 'closed';
      lead.rabbanit = resolveRabbanit(lead.rabbanit, users);
      lead.name = String(lead.name || '');
      lead.phone = String(lead.phone || '');
    });
    saveUsers(users);
    saveLeads(leads);
  }

  function init() {
    if (!ready) ready = migrate();
    return ready;
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
    if (!raw) return '';
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

  function phoneKey(phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 7) return '';
    return digits.length > 9 ? digits.slice(-9) : digits;
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

  function statusLabel(status) {
    return { open: 'פתוח', closed: 'נסגר', 'not-closed': 'לא נסגר', cancelled: 'ביטל' }[status] || status || '';
  }

  function orderLabel(status) {
    return { active: 'פעילה', inactive: 'לא פעילה', pending: 'ממתינה' }[status] || '';
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
        eventDate: '',
        classClosed: false,
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
    var rabbanit = cell(headers, row, 'rabbanit') || detectRabbanit(source);
    return {
      name: cell(headers, row, 'name'),
      phone: cell(headers, row, 'phone'),
      email: cell(headers, row, 'email'),
      source: source,
      notes: cell(headers, row, 'notes'),
      rabbanit: rabbanit,
      cost: num(cell(headers, row, 'cost'), 0),
      status: status,
      eventDate: cell(headers, row, 'eventDate'),
      classClosed: hasClosed ? mapClosed(cell(headers, row, 'classClosed')) : status === 'closed',
      standingOrders: num(cell(headers, row, 'standingOrders'), 0),
      cash: num(cell(headers, row, 'cash'), 0),
      orderStatus: mapOrderStatus(cell(headers, row, 'orderStatus')),
      monthlyAmount: num(cell(headers, row, 'monthlyAmount'), 0),
      oneTime: num(cell(headers, row, 'oneTime'), 0),
      eventCost: num(cell(headers, row, 'eventCost'), 0),
      orderStart: cell(headers, row, 'orderStart')
    };
  }

  function sanitizeAdminLead(input, prev, users) {
    var current = prev || {};
    var classClosed = typeof input.classClosed === 'boolean'
      ? input.classClosed
      : (input.classClosed === 'yes' || input.classClosed === 'כן'
        ? true
        : (input.classClosed === 'no' || input.classClosed === 'לא' ? false : !!current.classClosed));
    return {
      id: current.id || newId(),
      name: input.name !== undefined && input.name !== null ? String(input.name) : String(current.name || ''),
      phone: input.phone !== undefined && input.phone !== null ? String(input.phone) : String(current.phone || ''),
      email: str(input.email, current.email),
      source: str(input.source, current.source),
      cost: num(input.cost, current.cost),
      status: pickEnum(input.status, STATUSES, current.status || 'open'),
      standingOrders: num(input.standingOrders, current.standingOrders),
      cash: num(input.cash, current.cash),
      orderStatus: pickEnum(input.orderStatus, ORDER_STATUSES, current.orderStatus || ''),
      monthlyAmount: num(input.monthlyAmount, current.monthlyAmount),
      orderStart: str(input.orderStart, current.orderStart),
      oneTime: num(input.oneTime, current.oneTime),
      eventCost: num(input.eventCost, current.eventCost),
      rabbanit: sanitizeAssignment(input.rabbanit !== undefined ? input.rabbanit : current.rabbanit, current.rabbanit, users),
      eventDate: str(input.eventDate, current.eventDate),
      notes: str(input.notes, current.notes),
      createdAt: current.createdAt || new Date().toISOString(),
      history: cleanHistory(input.history != null ? input.history : current.history),
      classClosed: classClosed
    };
  }

  async function login(username, password) {
    await init();
    var users = loadUsers();
    var key = String(username || '').trim();
    var user = users[key];
    if (!user || !user.passHash) {
      session = null;
      return null;
    }
    var hash = await sha256(password == null ? '' : String(password));
    if (!safeEqual(hash, user.passHash)) {
      session = null;
      return null;
    }
    session = { username: key, name: user.name, role: user.role };
    return { username: key, name: user.name, role: user.role };
  }

  function logout() {
    session = null;
    return Promise.resolve();
  }

  function currentSession() {
    if (!session) return null;
    return { username: session.username, name: session.name, role: session.role };
  }

  async function listLeads() {
    await init();
    return leadsForSession(loadLeads());
  }

  async function listUsers() {
    await init();
    if (!session) return [];
    var users = publicUsers(loadUsers());
    if (session.role === 'admin') return users;
    if (session.role === 'operator') return users.filter(function (user) { return user.role === 'rabbanit'; });
    return [];
  }

  function saveLead(input) {
    return enqueue(async function () {
      await init();
      if (!session) throw new Error('אין הרשאה');
      if (session.role === 'operator' || session.role === 'unknown') throw new Error('אין הרשאה');
      var leads = loadLeads();
      var users = loadUsers();
      if (session.role === 'rabbanit') {
        var own = leads.find(function (lead) { return String(lead.id) === String(input && input.id); });
        if (!own || own.rabbanit !== session.username) throw new Error('אין הרשאה');
        var closed = asClosed(input.classClosed);
        if (!!own.classClosed !== closed) {
          var history = Array.isArray(own.history) ? own.history : [];
          history.push({
            date: new Date().toLocaleString('he-IL'),
            user: session.name,
            change: closed ? 'חוג בית נסגר' : 'חוג בית סומן כלא נסגר'
          });
          own.history = cleanHistory(history);
        }
        own.classClosed = closed;
        saveLeads(leads);
        return projectLead(own, 'rabbanit');
      }
      if (session.role !== 'admin') throw new Error('אין הרשאה');
      var existing = null;
      if (input && input.id) {
        existing = leads.find(function (lead) { return String(lead.id) === String(input.id); }) || null;
        if (!existing) throw new Error('הליד לא נמצא');
      }
      var stored = sanitizeAdminLead(input || {}, existing, users);
      if (existing) {
        var index = leads.findIndex(function (lead) { return lead.id === existing.id; });
        leads[index] = stored;
      } else {
        leads.unshift(stored);
      }
      saveLeads(leads);
      return projectLead(stored, 'admin');
    });
  }

  function saveEvent(id, patch) {
    return enqueue(async function () {
      await init();
      if (!session || session.role !== 'operator') throw new Error('אין הרשאה');
      var leads = loadLeads();
      var lead = leads.find(function (item) { return String(item.id) === String(id); });
      if (!lead || !String(lead.eventDate || '').trim()) throw new Error('האירוע לא נמצא');
      var orders = Number(patch && patch.standingOrders);
      var cash = Number(patch && patch.cash);
      if (!Number.isFinite(orders) || orders < 0) throw new Error('מספר הוראות הקבע אינו תקין');
      if (!Number.isFinite(cash) || cash < 0) throw new Error('סכום המזומן אינו תקין');
      lead.standingOrders = Math.round(orders);
      lead.cash = Math.round(cash * 100) / 100;
      lead.rabbanit = sanitizeAssignment(patch && patch.rabbanit, lead.rabbanit, loadUsers());
      var history = Array.isArray(lead.history) ? lead.history : [];
      history.push({ date: new Date().toLocaleString('he-IL'), user: session.name, change: 'עודכנו נתוני חוג' });
      lead.history = cleanHistory(history);
      saveLeads(leads);
      return projectLead(lead, 'operator');
    });
  }

  function deleteLead(id) {
    return enqueue(async function () {
      await init();
      requireAdmin();
      var leads = loadLeads();
      var next = leads.filter(function (lead) { return String(lead.id) !== String(id); });
      if (next.length === leads.length) throw new Error('הליד לא נמצא');
      saveLeads(next);
    });
  }

  function saveUser(input) {
    return enqueue(async function () {
      await init();
      requireAdmin();
      var users = loadUsers();
      var username = String(input && input.username || '').trim();
      var name = String(input && input.name || '').trim();
      var role = input && input.role === 'rabbanit' ? 'rabbanit' : (input && input.role === 'operator' ? 'operator' : '');
      var password = input && input.password ? String(input.password) : '';
      var creating = !!(input && input.create);
      if (!validUsername(username)) throw new Error('שם משתמש אינו תקין');
      if (!name) throw new Error('מלאו את השדות החובה');
      if (!role) throw new Error('תפקיד לא תקין');
      if (creating) {
        if (isReservedUsername(username) || (users[username] && users[username].role === 'admin')) {
          throw new Error('לא ניתן ליצור משתמש בשם admin או לדרוס את חשבון המנהל');
        }
        if (users[username]) throw new Error('שם המשתמש כבר קיים');
        if (!password) throw new Error('מלאו את השדות החובה');
        users[username] = {
          passHash: await sha256(password),
          name: name,
          role: role,
          rabbanit: role === 'rabbanit' ? name : ''
        };
      } else {
        if (!users[username]) throw new Error('המשתמש לא נמצא');
        if (users[username].role === 'admin' || isReservedUsername(username)) {
          throw new Error('לא ניתן ליצור משתמש בשם admin או לדרוס את חשבון המנהל');
        }
        users[username].name = name;
        users[username].role = role;
        users[username].rabbanit = role === 'rabbanit' ? name : '';
        if (password) users[username].passHash = await sha256(password);
        delete users[username].pass;
      }
      var leads = loadLeads();
      relinkLeads(users, leads);
      saveUsers(users);
      saveLeads(leads);
    });
  }

  function deleteUser(username) {
    return enqueue(async function () {
      await init();
      requireAdmin();
      var key = String(username || '').trim();
      var users = loadUsers();
      if (!users[key]) throw new Error('המשתמש לא נמצא');
      if (users[key].role === 'admin' || key === 'מנהל') throw new Error('לא ניתן למחוק את המנהל');
      delete users[key];
      saveUsers(users);
    });
  }

  function changePassword(username, password) {
    return enqueue(async function () {
      await init();
      requireAdmin();
      var key = String(username || '').trim();
      var users = loadUsers();
      if (!users[key]) throw new Error('המשתמש לא נמצא');
      if (!password) throw new Error('הזינו סיסמה');
      users[key].passHash = await sha256(String(password));
      delete users[key].pass;
      saveUsers(users);
    });
  }

  function importCsv(text) {
    return enqueue(async function () {
      await init();
      requireAdmin();
      var table = parseCsv(text);
      if (!table.length) return { added: 0, skipped: 0 };
      var known = knownHeaderSet();
      var first = table[0].map(normHeader);
      var hasHeader = first.some(function (item) { return known[item]; });
      var headers = hasHeader ? first : null;
      var data = hasHeader ? table.slice(1) : table;
      var users = loadUsers();
      var leads = loadLeads();
      var seen = Object.create(null);
      leads.forEach(function (lead) {
        var key = phoneKey(lead.phone);
        if (key) seen[key] = true;
      });
      var created = [];
      var skipped = 0;
      data.forEach(function (row) {
        var record = recordFromRow(row, headers);
        if (!record.name) return;
        var key = phoneKey(record.phone);
        if (key && seen[key]) { skipped++; return; }
        if (key) seen[key] = true;
        created.push({
          id: newId(),
          name: record.name,
          phone: record.phone,
          email: record.email,
          source: record.source,
          cost: record.cost,
          status: record.status,
          standingOrders: record.standingOrders,
          cash: record.cash,
          orderStatus: record.orderStatus,
          monthlyAmount: record.monthlyAmount,
          orderStart: record.orderStart,
          oneTime: record.oneTime,
          eventCost: record.eventCost,
          rabbanit: resolveRabbanit(record.rabbanit, users),
          eventDate: record.eventDate,
          notes: record.notes || 'יובא',
          createdAt: new Date().toISOString(),
          history: [{ date: new Date().toLocaleString('he-IL'), user: session.name, change: 'יובא' }],
          classClosed: !!record.classClosed
        });
      });
      if (created.length) saveLeads(created.concat(leads));
      return { added: created.length, skipped: skipped };
    });
  }

  async function exportCsv() {
    await init();
    if (!session || (session.role !== 'admin' && session.role !== 'rabbanit')) throw new Error('אין הרשאה');
    var users = loadUsers();
    var leads = loadLeads().filter(function (lead) {
      return session.role === 'admin' || lead.rabbanit === session.username;
    });
    function rabbanitName(key) {
      if (!key) return '';
      return users[key] ? (users[key].name || key) : String(key);
    }
    var header;
    var lines;
    if (session.role === 'admin') {
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
    changePassword: changePassword,
    importCsv: importCsv,
    exportCsv: exportCsv
  };
})(window);
