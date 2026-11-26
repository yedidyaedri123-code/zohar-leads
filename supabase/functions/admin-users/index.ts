import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const ROLES = ["admin", "activist", "rabbanit", "call_center"];
const ASCII_USERNAME = /^[a-z0-9._-]{3,32}$/;
const UNICODE_USERNAME = /^[\p{L}\p{N}._-]+(?: [\p{L}\p{N}._-]+)*$/u;
const EMAIL_DOMAIN = "zohar.local";

// Keep in sync with emailLocal() in data.js.
// A plain ASCII name stays "<name>@zohar.local". A space or any non-ASCII
// character becomes "u" + lowercase hex of the UTF-8 bytes.
// 31 bytes is the longest that fits: "u" + 62 hex chars = 63, under the
// 64-character email local-part limit.
function normalizeUsername(raw: unknown): string {
  return String(raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function emailLocal(username: string): string | null {
  if (ASCII_USERNAME.test(username)) return username;
  const needsHex = / /.test(username) || /[^\u0000-\u007F]/.test(username);
  if (!needsHex || !UNICODE_USERNAME.test(username)) return null;
  const bytes = new TextEncoder().encode(username);
  if (bytes.length > 31) return null;
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return "u" + hex;
}

function emailFor(username: string): string {
  const local = emailLocal(username);
  if (!local) throw new Error("invalid_username");
  return `${local}@${EMAIL_DOMAIN}`;
}

type AdminClient = ReturnType<typeof createClient>;

async function currentLink(admin: AdminClient, userId: string): Promise<string | null> {
  const { data } = await admin.from("rabbaniyot").select("id").eq("profile_id", userId).maybeSingle();
  return data?.id ?? null;
}

/** Link or unlink a profile to a rabbaniyot row. Clears any previous link for this user. */
async function setLink(admin: AdminClient, userId: string, rabbaniyaId: string | null): Promise<{ error?: string; detail?: string }> {
  await admin.from("rabbaniyot").update({ profile_id: null }).eq("profile_id", userId);
  if (!rabbaniyaId) return {};
  const { data: row, error: rErr } = await admin.from("rabbaniyot").select("id, profile_id").eq("id", rabbaniyaId).maybeSingle();
  if (rErr) return { error: "link_failed", detail: rErr.message };
  if (!row) return { error: "rabbaniya_not_found" };
  if (row.profile_id && row.profile_id !== userId) return { error: "rabbaniya_already_linked" };
  const { error } = await admin.from("rabbaniyot").update({ profile_id: userId }).eq("id", rabbaniyaId);
  if (error) return { error: "link_failed", detail: error.message };
  return {};
}

/**
 * For role=rabbanit: use an explicit id when given; otherwise link an unlinked
 * rabbaniyot row whose name equals display_name, or auto-create one.
 * Returns { id } or { error }.
 */
async function resolveRabbaniya(
  admin: AdminClient,
  displayName: string,
  explicitId: string | null,
  userId: string | null,
): Promise<{ id?: string; created?: boolean; error?: string; detail?: string }> {
  if (explicitId) return { id: explicitId };

  const { data: existing, error: findErr } = await admin
    .from("rabbaniyot")
    .select("id, profile_id")
    .eq("name", displayName)
    .maybeSingle();
  if (findErr) return { error: "link_failed", detail: findErr.message };
  if (existing) {
    if (existing.profile_id && existing.profile_id !== userId) {
      return { error: "rabbaniya_name_taken" };
    }
    return { id: existing.id };
  }

  const { data: created, error: insErr } = await admin
    .from("rabbaniyot")
    .insert({ name: displayName, active: true })
    .select("id")
    .single();
  if (insErr || !created?.id) {
    const taken = (insErr?.code === "23505") || /duplicate|unique/i.test(insErr?.message ?? "");
    return { error: taken ? "rabbaniya_name_taken" : "link_failed", detail: insErr?.message };
  }
  return { id: created.id, created: true };
}

async function renameLinkedRabbaniya(
  admin: AdminClient,
  rabbaniyaId: string,
  newName: string,
): Promise<{ error?: string; detail?: string }> {
  const { data: conflict, error: cErr } = await admin
    .from("rabbaniyot")
    .select("id")
    .eq("name", newName)
    .neq("id", rabbaniyaId)
    .maybeSingle();
  if (cErr) return { error: "link_failed", detail: cErr.message };
  if (conflict) return { error: "rabbaniya_name_taken" };
  const { error } = await admin.from("rabbaniyot").update({ name: newName }).eq("id", rabbaniyaId);
  if (error) {
    const taken = (error.code === "23505") || /duplicate|unique/i.test(error.message ?? "");
    return { error: taken ? "rabbaniya_name_taken" : "link_failed", detail: error.message };
  }
  return {};
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const authHeader = req.headers.get("Authorization") ?? req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "unauthorized" }, 401);
  const { data: u, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !u?.user) return json({ error: "unauthorized" }, 401);
  const callerId = u.user.id;
  const { data: caller } = await admin.from("profiles").select("role, active").eq("id", callerId).maybeSingle();
  if (!caller || caller.role !== "admin" || caller.active === false) return json({ error: "forbidden" }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const action = body?.action;

  const validPassword = (p: unknown) => typeof p === "string" && p.length >= 8 && p.length <= 72;
  const explicitId = (raw: unknown): string | null => {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).trim();
    return s ? s : null;
  };

  if (action === "list") {
    const { data, error } = await admin
      .from("profiles")
      .select("id, username, display_name, role, active, created_at")
      .order("created_at", { ascending: true });
    if (error) return json({ error: "list_failed", detail: error.message }, 400);
    const { data: links } = await admin.from("rabbaniyot").select("id, profile_id").not("profile_id", "is", null);
    const byProfile = new Map((links ?? []).map((r: any) => [r.profile_id, r.id]));
    const users = (data ?? []).map((p: any) => ({ ...p, rabbaniya_id: byProfile.get(p.id) ?? null }));
    return json({ ok: true, users });
  }

  if (action === "create") {
    const username = normalizeUsername(body.username);
    const display_name = String(body.display_name ?? "").trim();
    const role = String(body.role ?? "");
    const rabbaniya_id = explicitId(body.rabbaniya_id);
    const active = body.active === undefined ? true : Boolean(body.active);
    if (!emailLocal(username)) return json({ error: "invalid_username" }, 400);
    if (!display_name) return json({ error: "display_name_required" }, 400);
    if (!ROLES.includes(role)) return json({ error: "invalid_role" }, 400);
    if (!validPassword(body.password)) return json({ error: "invalid_password", hint: "8-72 chars" }, 400);

    const { data: existing } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
    if (existing) return json({ error: "username_taken" }, 409);

    let resolved: { id?: string; created?: boolean; error?: string; detail?: string } = {};
    if (role === "rabbanit" || rabbaniya_id) {
      if (role === "rabbanit") {
        resolved = await resolveRabbaniya(admin, display_name, rabbaniya_id, null);
        if (resolved.error || !resolved.id) {
          return json({ error: resolved.error ?? "link_failed", detail: resolved.detail }, resolved.error === "rabbaniya_name_taken" ? 409 : 400);
        }
      } else {
        resolved = { id: null as unknown as string };
      }
    }

    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email: emailFor(username),
      password: body.password,
      email_confirm: true,
      ban_duration: active ? "none" : "876000h",
    });
    if (cErr || !created?.user) {
      if (resolved.created && resolved.id) await admin.from("rabbaniyot").delete().eq("id", resolved.id);
      return json({ error: "create_failed", detail: cErr?.message }, 400);
    }

    const { error: pErr } = await admin.from("profiles").insert({
      id: created.user.id, username, display_name, role, active,
    });
    if (pErr) {
      await admin.auth.admin.deleteUser(created.user.id);
      if (resolved.created && resolved.id) await admin.from("rabbaniyot").delete().eq("id", resolved.id);
      return json({ error: "profile_failed", detail: pErr.message }, 400);
    }

    let linked: string | null = null;
    if (role === "rabbanit") {
      const link = await setLink(admin, created.user.id, resolved.id ?? null);
      if (link.error) {
        await admin.auth.admin.deleteUser(created.user.id);
        if (resolved.created && resolved.id) await admin.from("rabbaniyot").delete().eq("id", resolved.id);
        return json({ error: link.error, detail: link.detail }, link.error === "rabbaniya_already_linked" ? 409 : 400);
      }
      linked = resolved.id ?? null;
    }
    return json({ ok: true, user_id: created.user.id, username, email: emailFor(username), active, rabbaniya_id: linked }, 201);
  }

  if (action === "update") {
    const user_id = String(body.user_id ?? "");
    if (!user_id) return json({ error: "user_id_required" }, 400);
    const { data: target } = await admin.from("profiles").select("*").eq("id", user_id).maybeSingle();
    if (!target) return json({ error: "not_found" }, 404);
    const existingLink = await currentLink(admin, user_id);

    const patch: Record<string, unknown> = {};

    if (body.display_name !== undefined) {
      const d = String(body.display_name).trim();
      if (!d) return json({ error: "display_name_required" }, 400);
      patch.display_name = d;
    }
    const newDisplay = (patch.display_name as string | undefined) ?? target.display_name;

    const newRole = body.role !== undefined ? String(body.role) : target.role;
    if (!ROLES.includes(newRole)) return json({ error: "invalid_role" }, 400);
    if (newRole !== target.role) {
      if (user_id === callerId) return json({ error: "cannot_change_own_role" }, 400);
      patch.role = newRole;
    }

    let desiredLink: string | null | undefined = undefined; // undefined = leave as is
    let autoCreatedId: string | null = null;
    if (body.rabbaniya_id !== undefined || newRole !== target.role) {
      if (newRole === "rabbanit") {
        const id = body.rabbaniya_id !== undefined ? explicitId(body.rabbaniya_id) : existingLink;
        if (id) {
          desiredLink = id;
        } else if (existingLink) {
          desiredLink = existingLink;
        } else {
          const resolved = await resolveRabbaniya(admin, newDisplay, null, user_id);
          if (resolved.error || !resolved.id) {
            return json({ error: resolved.error ?? "link_failed", detail: resolved.detail }, resolved.error === "rabbaniya_name_taken" ? 409 : 400);
          }
          desiredLink = resolved.id;
          if (resolved.created) autoCreatedId = resolved.id;
        }
      } else {
        desiredLink = null;
      }
    }

    let newUsername: string | null = null;
    if (body.username !== undefined) {
      const username = normalizeUsername(body.username);
      if (!emailLocal(username)) return json({ error: "invalid_username" }, 400);
      if (username !== target.username) {
        const { data: taken } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
        if (taken) return json({ error: "username_taken" }, 409);
        newUsername = username;
      }
    }

    let newActive: boolean | null = null;
    if (body.active !== undefined) {
      const active = Boolean(body.active);
      if (!active && user_id === callerId) return json({ error: "cannot_disable_self" }, 400);
      if (active !== target.active) newActive = active;
    }

    if (newUsername) {
      // The auth email must follow the new readable username, including a
      // space or Hebrew name whose local-part is u+hex.
      const { error: emailErr } = await admin.auth.admin.updateUserById(user_id, {
        email: emailFor(newUsername),
        email_confirm: true,
      });
      if (emailErr) {
        if (autoCreatedId) await admin.from("rabbaniyot").delete().eq("id", autoCreatedId);
        return json({ error: "email_failed", detail: emailErr.message }, 400);
      }
      patch.username = newUsername;
    }

    if (newActive !== null) {
      const { error: banErr } = await admin.auth.admin.updateUserById(user_id, {
        ban_duration: newActive ? "none" : "876000h",
      });
      if (banErr) {
        if (newUsername) {
          await admin.auth.admin.updateUserById(user_id, { email: emailFor(target.username), email_confirm: true });
        }
        if (autoCreatedId) await admin.from("rabbaniyot").delete().eq("id", autoCreatedId);
        return json({ error: "ban_failed", detail: banErr.message }, 400);
      }
      patch.active = newActive;
    }

    if (body.password !== undefined) {
      if (!validPassword(body.password)) {
        if (newUsername) await admin.auth.admin.updateUserById(user_id, { email: emailFor(target.username), email_confirm: true });
        if (newActive !== null) await admin.auth.admin.updateUserById(user_id, { ban_duration: target.active ? "none" : "876000h" });
        if (autoCreatedId) await admin.from("rabbaniyot").delete().eq("id", autoCreatedId);
        return json({ error: "invalid_password", hint: "8-72 chars" }, 400);
      }
      const { error: pwErr } = await admin.auth.admin.updateUserById(user_id, { password: body.password });
      if (pwErr) {
        if (newUsername) await admin.auth.admin.updateUserById(user_id, { email: emailFor(target.username), email_confirm: true });
        if (newActive !== null) await admin.auth.admin.updateUserById(user_id, { ban_duration: target.active ? "none" : "876000h" });
        if (autoCreatedId) await admin.from("rabbaniyot").delete().eq("id", autoCreatedId);
        return json({ error: "password_failed", detail: pwErr.message }, 400);
      }
    }

    const willRenameList = (
      newRole === "rabbanit" &&
      (desiredLink === undefined ? existingLink : desiredLink) &&
      body.display_name !== undefined &&
      newDisplay !== target.display_name
    );
    if (willRenameList) {
      const pre = await renameLinkedRabbaniya(admin, (desiredLink === undefined ? existingLink : desiredLink) as string, newDisplay);
      if (pre.error) {
        if (autoCreatedId) await admin.from("rabbaniyot").delete().eq("id", autoCreatedId);
        return json({ error: pre.error, detail: pre.detail }, pre.error === "rabbaniya_name_taken" ? 409 : 400);
      }
    }

    if (Object.keys(patch).length) {
      const { error: upErr } = await admin.from("profiles").update(patch).eq("id", user_id);
      if (upErr) {
        if (newUsername) await admin.auth.admin.updateUserById(user_id, { email: emailFor(target.username), email_confirm: true });
        if (newActive !== null) await admin.auth.admin.updateUserById(user_id, { ban_duration: target.active ? "none" : "876000h" });
        if (autoCreatedId) await admin.from("rabbaniyot").delete().eq("id", autoCreatedId);
        return json({ error: "update_failed", detail: upErr.message }, 400);
      }
    }

    let linked: string | null = existingLink;
    if (desiredLink !== undefined && desiredLink !== existingLink) {
      const link = await setLink(admin, user_id, desiredLink);
      if (link.error) {
        if (autoCreatedId) await admin.from("rabbaniyot").delete().eq("id", autoCreatedId);
        return json({ error: link.error, detail: link.detail }, link.error === "rabbaniya_already_linked" ? 409 : 400);
      }
      linked = desiredLink;
    }

    const finalLink = desiredLink === undefined ? existingLink : linked;

    return json({
      ok: true,
      username: newUsername ?? target.username,
      email: emailFor((newUsername ?? target.username) as string),
      active: newActive ?? target.active,
      rabbaniya_id: finalLink,
    });
  }

  if (action === "delete") {
    const user_id = String(body.user_id ?? "");
    if (!user_id) return json({ error: "user_id_required" }, 400);
    if (user_id === callerId) return json({ error: "cannot_delete_self" }, 400);
    const { error: dErr } = await admin.auth.admin.deleteUser(user_id);
    if (dErr) return json({ error: "delete_failed", detail: dErr.message }, 400);
    return json({ ok: true });
  }

  return json({ error: "unknown_action", actions: ["list", "create", "update", "delete"] }, 400);
});
