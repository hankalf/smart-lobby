/*
 * The site itself: staff, doors, locations, printers and tablets.
 */
import { $, $$, ME, SETTINGS, VIEWS, allowed, api, confirmAction, copyText, esc, fmtDate, modal, render, toast,
  upload
} from './core.js';

VIEWS.staff = async (root) => {
  const rows = await api('/staff');
  // Which staff members have a dashboard login, and at what level.
  const [logins, levels] = await Promise.all([api('/users'), api('/roles')]);
  const loginFor = (hostId) => logins.find((u) => u.host_id === hostId) || null;
  const levelName = (role) => (levels.find((l) => l.key === role) || {}).label || role;

  root.innerHTML = `
    <h1 class="page">Staff</h1>
    <p class="page-sub">The people visitors can ask for. An email address is all most of them need — it is what lets
      Smart Lobby tag them in your Teams channel when their visitor arrives.</p>
    <div class="card section">
      <div class="inline-form" style="margin-bottom:1rem">
        <label class="field"><span>Name</span><input class="input" id="h-name"></label>
        <label class="field"><span>Email</span><input class="input" id="h-email" type="email"></label>
        <label class="field"><span>Mobile (for SMS)</span><input class="input" id="h-phone" type="tel"></label>
        <label class="field"><span>Department</span><input class="input" id="h-dept"></label>
        <button class="btn" id="h-add">Add staff member</button>
      </div>
      <!--
        Folded away because it is the exception, not a step. Most people are
        reached by being tagged in the Teams channel, which needs nothing on
        their record beyond an email — see Settings › Notifications.
      -->
      <details class="sub-fold">
        <summary><h3>A personal chat link</h3>
          <span class="muted">Only for somebody who is not in your Teams channel</span></summary>
        <p class="muted" style="margin-top:0">Tagging someone in the channel only notifies them if they are a member
          of it. For a supervisor or manager who is not, a personal chat webhook sends the arrival straight to them
          as a direct message. It is also what makes an <b>Also tell</b> list under
          <b>Settings › Notifications</b> arrive as a message rather than only a tag.</p>
        <label class="field" style="max-width:32rem"><span>Chat webhook</span>
          <input class="input" id="h-hook" placeholder="Slack, Teams or Google Chat URL"></label>
      </details>
      <div class="table-wrap">${rows.length ? `<table>
        <thead><tr><th>Name</th><th>Email</th><th>Mobile</th><th>Department</th>
          <th>Dashboard access</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((h) => {
          const login = loginFor(h.id);
          return `<tr><td><b>${esc(h.name)}</b>${h.webhook_url
            ? ' <span class="pill on" title="Has a personal chat link, so arrivals reach them directly">DM</span>' : ''}</td>
          <td>${esc(h.email || '')}</td>
          <td>${esc(h.phone || '')}</td>
          <td>${esc(h.department || '')}</td>
          <td>${login
            ? `<span class="pill ${login.active ? 'on' : 'off'}">${esc(levelName(login.role))}</span>
               ${login.must_change_password ? '<div class="muted">must pick a password</div>' : ''}
               ${login.role === 'owner' ? '<div class="muted">owner</div>' : ''}`
            : '<span class="muted">No login</span>'}</td>
          <td><span class="pill ${h.active ? 'on' : 'off'}">${h.active ? 'active' : 'off'}</span></td>
          <td style="white-space:nowrap"><button class="btn ghost" data-hedit="${h.id}">Edit</button>
              <button class="btn ghost" data-haccess="${h.id}">${login ? 'Access' : 'Give a login'}</button>
              <button class="btn ghost" data-hdel="${h.id}">Remove</button></td></tr>`;
        }).join('')}</tbody></table>`
        : '<p class="empty">No staff yet — add the people visitors come to see.</p>'}</div>
      <p class="muted"><b>Dashboard access</b> is separate from being someone a visitor can ask for. A staff member
        with no login simply never signs in here.</p>
    </div>

    <div class="card section">
      <h2>Add several at once from a spreadsheet</h2>
      <p class="muted" style="margin-top:0">Upload an Excel file (<b>.xlsx</b>) or a <b>.csv</b>. The first row should be
        headings — <i>First name</i>, <i>Last name</i>, <i>Email</i>, <i>Phone</i>, <i>Department</i>,
        <i>Chat webhook</i>. Only the name is required, and headings can be worded your way: a single
        <i>Full name</i> column works just as well as separate first and last, and “Mobile”, “Surname”, “Team” and
        similar are all understood.</p>
      <p class="muted">Someone already on the list is updated rather than duplicated, matched on email, or on name when
        there is no email — so you can fix a sheet and upload it again.</p>
      <div class="row">
        <label class="btn subtle">Choose spreadsheet<input type="file" hidden id="staff-file" accept=".xlsx,.xlsm,.csv,.txt"></label>
        <a class="btn ghost" href="/api/admin/staff/template.csv">Download a template</a>
      </div>
      <div id="import-result"></div>
    </div>

    <div class="card section">
      <h2>Setting up a chat webhook</h2>
      <p class="muted" style="margin-top:0">Most sites need only one of these: the company channel, set once under
        <b>Settings → Notifications</b>. Everyone in that channel is reached by being tagged in the post, which
        needs nothing here beyond their email address.</p>
      <p class="muted">A personal link is for the exception — somebody who is <i>not</i> in that channel, and so
        would never see the tag. Paste it into their <b>A personal chat link</b> box above and their visitors'
        arrivals go straight to them as a direct message. It is also what makes an <b>Also tell</b> list under
        Notifications arrive as a message rather than only a tag. Slack and Google Chat links work too, recognised
        from the URL, so different people can be on different platforms.</p>

      <details class="howto">
        <summary><b>Microsoft Teams</b> — to a channel, or as a direct message to one person</summary>
        <p><b>To a channel</b></p>
        <ol>
          <li>In Teams, hover the channel → <b>⋯</b> → <b>Workflows</b>.</li>
          <li>Choose the template <b>“Post to a channel when a webhook request is received”</b>.</li>
          <li>Name it “Smart Lobby”, confirm the team and channel, then <b>Add workflow</b>.</li>
          <li>Copy the HTTPS URL it shows you — you only get it once.</li>
          <li>Paste it into the staff member's <b>Chat webhook</b> box above.</li>
        </ol>
        <p><b>To one person (a DM)</b> — use this when a site manager should be pinged directly rather than
          in a shared channel. To send it to <i>yourself</i>, start from a chat with yourself.</p>
        <ol>
          <li>In Teams, click <b>New chat</b>, type your own name and pick yourself — Teams opens a chat with
            you. (For someone else, just open your chat with them.)</li>
          <li>Hover that chat in the list → <b>⋯</b> → <b>Workflows</b>. Or open the <b>Workflows</b> app from
            the left rail and choose <b>+ New flow</b>.</li>
          <li>Choose the template <b>“Post to a chat when a webhook request is received”</b> — the
            <i>chat</i> one, not the channel one.</li>
          <li>Confirm the chat it will post into, then <b>Add workflow</b>, and copy the URL. You only get it once.</li>
          <li>Paste it into that person's <b>Chat webhook</b> box above. Only their visitors trigger it.</li>
        </ol>
        <p class="muted"><b>If the chat template is not offered</b> — some tenants only expose the channel one.
          Go to <b>make.powerautomate.com</b> → <b>Create</b> → <b>Automated cloud flow</b>, pick the trigger
          <b>“When a Teams webhook request is received”</b> and set <i>Who can trigger</i> to <b>Anyone</b>. Add
          the action <b>“Post message in a chat or channel”</b> with <i>Post as</i> = <b>Flow bot</b>,
          <i>Post in</i> = <b>Chat with Flow bot</b> and <i>Recipient</i> = your own address. Save, then copy the
          trigger's HTTP URL.</p>
        <!--
          Named verbatim because that is what somebody will paste into a
          search box at five past six, and because the failure arrives by
          email from Microsoft rather than anywhere in this app: the webhook
          answers 202 the moment it takes the request and fails afterwards,
          so nothing here can see it.
        -->
        <div class="notice warn"><b>If Power Automate emails you “Call made for a thread which is not a
          ChatThread”</b> — the flow is set to post into a <i>chat</i> but was given a <i>channel</i>, which
          happens when the workflow was created from a channel and then pointed at a chat. The message never
          arrives and you get a failed-run email for every visitor, so it is worth fixing rather than muting.
          <br><br>Open the flow at <b>make.powerautomate.com</b> → <b>My flows</b> → edit → the
          <b>Post card in a chat or channel</b> step, and set <i>Post in</i> = <b>Chat with Flow bot</b> with
          <i>Recipient</i> = the person's address. That variant needs no existing thread, which is exactly why
          it does not hit this. Save and test again. Rebuilding from the chat template works too, but it has to
          be started from the chat itself, not from a channel.</div>
        <p class="muted">The message arrives from <b>Flow bot</b> rather than from a person, which is normal.
          Some tenants restrict the chat template — if you cannot see it, your IT admin controls that.
          Microsoft is also retiring the older Office 365 connectors; if your tenant still offers
          <b>⋯ → Connectors → Incoming Webhook</b> it works, but it is channel-only and going away.</p>
      </details>

      <details class="howto">
        <summary><b>Slack</b> — posts with the visitor's photo</summary>
        <ol>
          <li>Go to <b>api.slack.com/apps</b> → <b>Create New App</b> → <b>From scratch</b>. Name it
            “Smart Lobby” and pick your workspace.</li>
          <li>In the left menu choose <b>Incoming Webhooks</b> and switch it <b>On</b>.</li>
          <li>Click <b>Add New Webhook to Workspace</b>, choose the channel (or a direct message to that person),
            then <b>Allow</b>.</li>
          <li>Copy the URL — it looks like
            <code class="token">https://hooks.slack.com/services/T00000/B00000/XXXX</code>.</li>
          <li>Paste it into the host's <b>Chat webhook</b> box above and click <b>Add staff member</b> (or edit an
            existing one).</li>
        </ol>
        <p class="muted">Repeat steps 3–5 for each channel you want to post to; one app can hold many webhooks.</p>
      </details>

      <details class="howto">
        <summary><b>Google Chat</b></summary>
        <ol>
          <li>Open the space in Google Chat and click the space name at the top.</li>
          <li>Choose <b>Apps &amp; integrations</b> → <b>Webhooks</b> → <b>Add webhook</b>.</li>
          <li>Name it “Smart Lobby” and click <b>Save</b>.</li>
          <li>Copy the URL — it starts with
            <code class="token">https://chat.googleapis.com/v1/spaces/…</code>.</li>
          <li>Paste it into the staff member's <b>Chat webhook</b> box above.</li>
        </ol>
        <p class="muted">Webhooks are only available in spaces, not in one-to-one chats, and your Workspace
          admin must allow them.</p>
      </details>

      <details class="howto">
        <summary><b>Anything else</b> — Mattermost, n8n, Zapier, your own endpoint</summary>
        <p>Paste any URL that accepts a JSON POST. Unrecognised URLs use the format set in
          <b>Settings → Notifications</b>; choose <b>Generic JSON</b> there to receive:</p>
        <pre class="token" style="white-space:pre-wrap">{ "event": "John Doe has arrived to see Jane Doe",
"details": ["Visitor: John Doe (Example Roofing)", "Type: contractor", "..."],
"photo_url": "https://…/media/private/photos/….jpg",
"timestamp": "2026-08-25T13:41:11.955Z" }</pre>
      </details>

      <p class="muted">To check a webhook before a real visitor uses it, paste it into
        <b>Settings → Notifications → Fallback chat webhook</b> and press <b>Send test webhook</b>. Every attempt,
        successful or not, is recorded against the visit under <b>Visits → View</b>.</p>
    </div>`;
  $('#h-add').addEventListener('click', async () => {
    if (!$('#h-name').value.trim()) return toast('Enter a name');
    await api('/staff', { method: 'POST', body: {
      name: $('#h-name').value.trim(), email: $('#h-email').value.trim(), phone: $('#h-phone').value.trim(),
      department: $('#h-dept').value.trim(), webhook_url: $('#h-hook').value.trim(), active: 1 } });
    render('staff');
  });
  $$('[data-hdel]').forEach((b) => b.addEventListener('click', () => confirmAction(
    'Remove this person? Past visits keep their name; they just stop being offered on the kiosk.',
    async () => { await api(`/staff/${b.dataset.hdel}`, { method: 'DELETE' }); render('staff'); })));

  /**
   * Dashboard access for one staff member, granted where the person already
   * exists rather than as a second, unrelated list of accounts.
   */
  $$('[data-haccess]').forEach((b) => b.addEventListener('click', () => {
    const staff = rows.find((h) => h.id === Number(b.dataset.haccess));
    const login = loginFor(staff.id);
    const owner = login && login.role === 'owner';
    const iAmOwner = ME && ME.role === 'owner';

    const options = levels
      .filter((l) => l.key !== 'admin' || iAmOwner)
      .map((l) => `<option value="${l.key}" ${login && login.role === l.key ? 'selected' : ''}>${esc(l.label)}</option>`)
      .join('');

    modal(`Dashboard access — ${staff.name}`, `
      ${owner ? '<div class="notice">This is the owner account. Its access level cannot be changed, and it '
        + 'cannot be removed — an install nobody can reach the settings on is an install nobody can fix.</div>' : ''}
      ${login ? `<p class="muted">Signs in as <b>${esc(login.email)}</b>.</p>` : `
        <label class="field"><span>Email to sign in with</span>
          <input class="input" id="ax-email" type="email" value="${esc(staff.email || '')}"></label>`}
      <label class="field"><span>Access level</span>
        <select class="input" id="ax-role" ${owner ? 'disabled' : ''}>${options}</select>
        <div class="muted" id="ax-describe" style="margin-top:.35rem"></div></label>
      ${login ? '' : `
        <label class="field"><span>Temporary password</span>
          <input class="input" id="ax-pass" type="text" autocomplete="off">
          <span class="muted">They will have to pick their own the first time they sign in, so this one
            stops working the moment they do.</span></label>`}
      ${login && !owner ? `
        <div class="row" style="margin-top:1rem">
          <button class="btn subtle" id="ax-reset" type="button">Reset their password</button>
          <button class="btn ghost" id="ax-remove" type="button">Remove their login</button>
        </div>` : ''}
      <div id="ax-result"></div>`,
    async (bg, close) => {
      const role = $('#ax-role').value;
      if (login) {
        if (!owner) {
          try {
            await api(`/users/${login.id}`, { method: 'PATCH', body: { role } });
            toast(`${staff.name} is now ${levelName(role)}`);
          } catch (err) {
            return toast((err.data && err.data.message) || 'Could not change that level');
          }
        }
      } else {
        const email = $('#ax-email').value.trim();
        const password = $('#ax-pass').value;
        if (!email) return toast('An email address is needed to sign in with');
        if (String(password).length < 8) return toast('The temporary password needs at least 8 characters');
        try {
          await api('/users', { method: 'POST', body: {
            email, password, name: staff.name, role, host_id: staff.id, must_change: true } });
          toast(`${staff.name} can sign in as ${levelName(role)} with that password`, 6000);
        } catch (err) {
          return toast((err.data && err.data.message) || 'Could not create that login');
        }
      }
      close();
      render('staff');
    }, login ? 'Save' : 'Create the login');

    // What each level actually means, beside the picker rather than in a manual.
    const describe = () => {
      const chosen = levels.find((l) => l.key === $('#ax-role').value);
      $('#ax-describe').textContent = chosen ? chosen.describe : '';
    };
    $('#ax-role').addEventListener('change', describe);
    describe();
    // A first password nobody has to invent.
    const pass = $('#ax-pass');
    if (pass) pass.value = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);

    const reset = $('#ax-reset');
    if (reset) reset.addEventListener('click', async () => {
      const next = prompt(`New temporary password for ${staff.name} — at least 8 characters.\n\n`
        + 'They will be signed out everywhere and asked to pick their own.');
      if (next === null) return;
      try {
        const r = await api(`/users/${login.id}/password`, { method: 'POST', body: { password: next } });
        $('#ax-result').innerHTML = `<div class="notice">${esc(r.message)}</div>`;
      } catch (err) {
        $('#ax-result').innerHTML = `<div class="notice error">${esc((err.data && err.data.message) || 'Could not reset it.')}</div>`;
      }
    });

    const remove = $('#ax-remove');
    if (remove) remove.addEventListener('click', async () => {
      if (!confirm(`Remove ${staff.name}'s login? They stay on the staff list — they just cannot sign in here.`)) return;
      try {
        await api(`/users/${login.id}`, { method: 'DELETE' });
        toast('Login removed');
        $('#modal-root').innerHTML = '';
        render('staff');
      } catch { toast('Could not remove that login'); }
    });
  }));

  $$('[data-hedit]').forEach((b) => b.addEventListener('click', () => {
    const person = rows.find((x) => String(x.id) === b.dataset.hedit);
    const m = modal(`Edit ${person.name}`, `
      <div class="form-grid">
        <label class="field"><span>Name</span><input class="input" id="se-name" value="${esc(person.name)}"></label>
        <label class="field"><span>Email</span><input class="input" id="se-email" type="email" value="${esc(person.email || '')}"></label>
        <label class="field"><span>Mobile (for SMS)</span><input class="input" id="se-phone" type="tel" value="${esc(person.phone || '')}"></label>
        <label class="field"><span>Department</span><input class="input" id="se-dept" value="${esc(person.department || '')}"></label>
      </div>
      <details class="sub-fold" ${person.webhook_url ? 'open' : ''}>
        <summary><h3>A personal chat link</h3>
          <span class="muted">Only if they are not in your Teams channel</span></summary>
        <p class="muted" style="margin-top:0">Being tagged in the channel only notifies a member of it. This sends
          arrivals to them directly instead, and is what makes an <b>Also tell</b> list arrive as a message.</p>
        <label class="field"><span>Chat webhook</span>
          <input class="input" id="se-hook" placeholder="Slack, Teams or Google Chat URL" value="${esc(person.webhook_url || '')}"></label>
        <div class="row"><button class="btn subtle" type="button" id="se-test">Send a test to this webhook</button></div>
        <div id="se-test-result"></div>
      </details>
      <label class="check"><input type="checkbox" id="se-active" ${person.active ? 'checked' : ''}>
        <span>Offered on the kiosk<br><span class="muted">Switch off for someone who has left, without losing their history</span></span></label>`,
      async (bg, close) => {
        await api(`/staff/${person.id}`, { method: 'PATCH', body: {
          name: $('#se-name', bg).value.trim(),
          email: $('#se-email', bg).value.trim(),
          phone: $('#se-phone', bg).value.trim(),
          department: $('#se-dept', bg).value.trim(),
          webhook_url: $('#se-hook', bg).value.trim(),
          active: $('#se-active', bg).checked ? 1 : 0
        } });
        close(); render('staff');
      });

    // Tests whatever is currently in the box, so a URL can be proved before saving.
    $('#se-test', m.bg).addEventListener('click', async () => {
      const box = $('#se-test-result', m.bg);
      box.innerHTML = '<p class="muted">Sending…</p>';
      const r = await api(`/staff/${person.id}/test-webhook`, {
        method: 'POST', body: { url: $('#se-hook', m.bg).value.trim() }
      });
      box.innerHTML = r.ok
        ? `<div class="notice ${r.accepted_only ? 'warn' : ''}"><b>${r.accepted_only ? 'Accepted.' : 'Delivered.'}</b>
           ${esc(r.detail || 'Check the chat it should have landed in.')}</div>`
        : `<div class="notice error"><b>Not delivered.</b> ${esc(r.detail || r.error || '')}</div>`;
    });
  }));

  $('#staff-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const box = $('#import-result');
    box.innerHTML = '<p class="muted">Reading the spreadsheet…</p>';
    try {
      const r = await upload('/staff/import', file);
      const bits = [`<b>${r.created}</b> added`, `<b>${r.updated}</b> updated`];
      if (r.skipped.length) bits.push(`<b>${r.skipped.length}</b> skipped`);
      box.innerHTML = `<div class="notice">${bits.join(' · ')}
        ${r.skipped.length ? `<br><span class="muted">Skipped rows: ${r.skipped.map((s) => `line ${s.line} (${esc(s.reason)})`).join(', ')}</span>` : ''}</div>`;
      setTimeout(() => render('staff'), 1200);
    } catch (err) {
      const reason = {
        no_name_column: 'Could not find a Name column. The first row should be headings.',
        unsupported_file_type: 'Please upload a .xlsx or .csv file.',
        old_excel_format: 'That is the older .xls format — open it in Excel and save as .xlsx or .csv.',
        empty_file: 'That spreadsheet appears to be empty.',
        not_a_zip: 'That file could not be read as a spreadsheet.'
      }[err.data && err.data.error] || 'That spreadsheet could not be read.';
      box.innerHTML = `<div class="notice error">${esc(reason)}</div>`;
    }
    e.target.value = '';
  });
};

/* --------------------------------------------------------------- access */

VIEWS.access = async (root) => {
  const [points, events] = await Promise.all([api('/access-points'), api('/access-events')]);
  root.innerHTML = `
    <h1 class="page">Access &amp; doors</h1>
    <p class="page-sub">Each door is an HTTP call to your relay or access controller — Shelly, Tasmota, ESPHome,
      Home Assistant or any webhook. Placeholders <code class="token">{{seconds}}</code>, <code class="token">{{door}}</code>,
      <code class="token">{{actor}}</code> are filled in at unlock time.</p>
    <div class="row"><button class="btn" id="ap-new">Add door</button></div>
    ${points.length ? points.map((p) => `<div class="card section">
      <div class="row between"><div><h2 style="margin:0">${esc(p.name)} <span class="pill ${p.enabled ? 'on' : 'off'}">${p.enabled ? 'enabled' : 'off'}</span></h2>
      <span class="muted">${esc(p.method)} ${esc(p.url || '')}</span></div>
      <div class="row" style="margin:0"><button class="btn subtle" data-fire="${p.id}">Test unlock</button>
      <button class="btn ghost" data-apedit="${p.id}">Edit</button>
      <button class="btn ghost" data-apdel="${p.id}">Delete</button></div></div>
      <p class="muted">Auto-unlock on sign-in: ${p.auto_unlock_on_signin ? 'yes' : 'no'} ·
        on sign-out: ${p.auto_unlock_on_signout ? 'yes' : 'no'} · hold ${p.unlock_seconds}s</p>
      ${p.notes ? `<pre class="muted" style="white-space:pre-wrap;margin:.5rem 0 0">${esc(p.notes)}</pre>` : ''}</div>`).join('')
      : '<div class="card section"><p class="empty">No doors configured.</p></div>'}
    <div class="card section">
      <h2>Wiring this to an access control panel</h2>
      <p class="muted" style="margin-top:0">Smart Lobby only ever makes an HTTP call. A panel — Honeywell, Paxton,
        Net2 or anything else — is reached through a small relay module on the same network: Smart Lobby calls the
        relay, the relay closes a contact for a moment, and the panel treats it exactly like a button on the wall.
        Nothing needs to be added to the panel's own software.</p>
      <details class="howto">
        <summary><b>Honeywell panel — how it goes together</b></summary>
        <ol>
          <li>Fit a network relay module (a Shelly 1 or similar dry-contact relay) near the panel, on the same
            network as this server.</li>
          <li>Wire its output contacts across the door's <b>REX / request-to-exit</b> input, or a spare auxiliary
            input configured to release that door — the same terminals a push-to-exit button uses.</li>
          <li>Set the relay to <b>momentary</b>, matching the unlock hold you set here, so it pulses rather than
            latching the door open.</li>
          <li>Add the door here with <b>Honeywell panel via relay module</b> and the relay's address, then press
            <b>Test unlock</b>. Every attempt is logged below with what came back.</li>
        </ol>
        <p class="muted">Wiring into a REX input keeps the panel in charge of the door: its own schedules,
          interlocks and fire release still apply, and the panel's log still records the release. Have your
          installer confirm which terminals to use — that is a decision about the door, not about this software.</p>
      </details>
      <details class="howto">
        <summary><b>Setting it up before it is wired</b></summary>
        <p>Add the door now with a name and whatever you know, write the panel, door and terminals into the
          wiring notes, and leave <b>Enabled</b> unticked. It stays listed, appears in no kiosk, and is never
          called. When the relay goes in, put its address in and tick Enabled.</p>
      </details>
    </div>

    <div class="card section"><h2>Recent unlock events</h2>
      ${events.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Door</th><th>Actor</th><th>Source</th><th>Result</th></tr></thead>
      <tbody>${events.map((e) => `<tr><td>${fmtDate(e.created_at)}</td><td>${esc(e.access_point_name || '')}</td>
        <td>${esc(e.actor || '')}</td><td>${esc(e.trigger_source || '')}</td>
        <td><span class="pill ${e.result === 'ok' ? 'on' : 'off'}">${esc(e.result)}</span> <span class="muted">${esc(e.detail || '')}</span></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="empty">No unlocks recorded yet.</p>'}</div>`;

  $('#ap-new').addEventListener('click', () => doorEditor(null));
  $$('[data-apedit]').forEach((b) => b.addEventListener('click', () => doorEditor(points.find((p) => String(p.id) === b.dataset.apedit))));
  $$('[data-apdel]').forEach((b) => b.addEventListener('click', () => confirmAction('Delete this door?',
    async () => { await api(`/access-points/${b.dataset.apdel}`, { method: 'DELETE' }); render('access'); })));
  $$('[data-fire]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api(`/access-points/${b.dataset.fire}/trigger`, { method: 'POST' });
    toast(r.ok ? `Unlocked (${r.detail})` : `Failed: ${r.detail || r.error}`);
    render('access');
  }));
};

/*
 * Ways a door gets opened. Smart Lobby only ever makes an HTTP call, so any
 * panel is reached through a relay module that closes a contact — which is how
 * a Honeywell, Paxton or any other board is wired to a third-party trigger.
 */
const DOOR_TEMPLATES = {
  honeywell: {
    label: 'Honeywell panel via relay module',
    url: 'http://192.168.1.50/relay/0?turn=on&timer={{seconds}}',
    method: 'GET', headers: '', body: '',
    notes: 'Relay output wired across the REX (request-to-exit) or auxiliary input on the Honeywell panel.\n'
      + 'Panel: \nDoor / reader: \nTerminals: \nRelay module IP: '
  },
  shelly: {
    label: 'Shelly relay',
    url: 'http://192.168.1.50/relay/0?turn=on&timer={{seconds}}',
    method: 'GET', headers: '', body: '', notes: ''
  },
  tasmota: {
    label: 'Tasmota relay',
    url: 'http://192.168.1.50/cm?cmnd=Power%20On',
    method: 'GET', headers: '', body: '', notes: ''
  },
  homeassistant: {
    label: 'Home Assistant',
    url: 'http://192.168.1.10:8123/api/services/lock/unlock',
    method: 'POST',
    headers: '{"Authorization":"Bearer YOUR_LONG_LIVED_TOKEN"}',
    body: '{"entity_id":"lock.front_door"}', notes: ''
  },
  webhook: { label: 'Something else', url: '', method: 'POST', headers: '', body: '', notes: '' }
};

function doorEditor(p) {
  const m = modal(p ? 'Edit door' : 'Add door', `
    <div class="form-grid">
      <label class="field"><span>Name</span><input class="input" id="ap-name" value="${esc(p ? p.name : 'Front door')}"></label>
      <label class="field"><span>How it is opened</span><select class="input" id="ap-template">
        <option value="">— choose to fill in the rest —</option>
        ${Object.entries(DOOR_TEMPLATES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('')}
      </select></label>
    </div>
    <div class="form-grid">
      <label class="field"><span>Method</span><select class="input" id="ap-method">
        ${['POST', 'GET', 'PUT'].map((m) => `<option ${p && p.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label class="field"><span>Unlock hold (seconds)</span>
        <input class="input" id="ap-secs" type="number" min="1" value="${p ? p.unlock_seconds : 5}"></label>
    </div>
    <label class="field"><span>URL</span><input class="input" id="ap-url" placeholder="http://192.168.1.50/relay/0?turn=on&amp;timer={{seconds}}"
      value="${esc(p ? p.url || '' : '')}"></label>
    <label class="field"><span>Headers (JSON, optional)</span><input class="input" id="ap-headers"
      placeholder='{"Authorization":"Bearer …"}' value="${esc(p ? p.headers || '' : '')}"></label>
    <label class="field"><span>Body template (optional)</span><textarea class="input" id="ap-body" rows="3"
      placeholder='{"action":"unlock","seconds":{{seconds}}}'>${esc(p ? p.body || '' : '')}</textarea></label>
    <label class="field"><span>Wiring notes</span>
      <textarea class="input" id="ap-notes" rows="4"
        placeholder="Panel, door, terminals, relay address — whatever the installer will need">${esc(p ? p.notes || '' : '')}</textarea>
      <span class="muted">For your own record. Nothing here is sent anywhere.</span></label>

    <label class="check"><input type="checkbox" id="ap-in" ${p && p.auto_unlock_on_signin ? 'checked' : ''}> Unlock automatically when a visitor signs in</label>
    <label class="check"><input type="checkbox" id="ap-out" ${p && p.auto_unlock_on_signout ? 'checked' : ''}> Unlock automatically when a visitor signs out</label>
    <label class="check"><input type="checkbox" id="ap-en" ${!p || p.enabled ? 'checked' : ''}>
      <span>Enabled<br><span class="muted">Leave this off until it is wired — the door is listed but never called</span></span></label>`,
    async (bg, close) => {
      const body = {
        name: $('#ap-name', bg).value, method: $('#ap-method', bg).value, url: $('#ap-url', bg).value,
        headers: $('#ap-headers', bg).value, body: $('#ap-body', bg).value,
        notes: $('#ap-notes', bg).value,
        unlock_seconds: Number($('#ap-secs', bg).value) || 5,
        auto_unlock_on_signin: $('#ap-in', bg).checked ? 1 : 0,
        auto_unlock_on_signout: $('#ap-out', bg).checked ? 1 : 0,
        enabled: $('#ap-en', bg).checked ? 1 : 0
      };
      if (p) await api(`/access-points/${p.id}`, { method: 'PATCH', body });
      else await api('/access-points', { method: 'POST', body });
      close(); render('access');
    });

  // Picking how the door is opened fills in the rest, leaving the address to change.
  $('#ap-template', m.bg).addEventListener('change', (e) => {
    const t = DOOR_TEMPLATES[e.target.value];
    if (!t) return;
    $('#ap-url', m.bg).value = t.url;
    $('#ap-method', m.bg).value = t.method;
    $('#ap-headers', m.bg).value = t.headers;
    $('#ap-body', m.bg).value = t.body;
    if (t.notes && !$('#ap-notes', m.bg).value.trim()) $('#ap-notes', m.bg).value = t.notes;
  });
}

/* ------------------------------------------------------------ locations */

VIEWS.locations = async (root) => {
  const [rows, sites] = await Promise.all([api('/locations'), api('/sites')]);
  const multiSite = sites.length > 1;
  root.innerHTML = `
    <h1 class="page">Locations</h1>
    <p class="page-sub">Areas within a site — reception, the yard gate, the workshop entrance. Each device belongs to a
      location, so you can see where somebody signed in and run a roll call area by area.</p>
    <div class="card section">
      <div class="inline-form" style="margin-bottom:1rem">
        <label class="field"><span>Location name</span><input class="input" id="lo-name" placeholder="Main reception"></label>
        <label class="field"><span>Description</span><input class="input" id="lo-desc" placeholder="Ground floor, front of building"></label>
        ${multiSite ? `<label class="field"><span>Site</span><select class="input" id="lo-site">
          ${sites.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>` : ''}
        <button class="btn" id="lo-add">Add location</button>
      </div>
      <div class="table-wrap">${rows.length ? `<table>
        <thead><tr><th>Name</th><th>Description</th>${multiSite ? '<th>Site</th>' : ''}<th>Devices</th><th>On site now</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((l) => `<tr>
          <td><b>${esc(l.name)}</b></td>
          <td class="muted">${esc(l.description || '')}</td>
          ${multiSite ? `<td>${esc(l.site_name || '')}</td>` : ''}
          <td>${l.device_count}</td>
          <td>${l.onsite}</td>
          <td><span class="pill ${l.active ? 'on' : 'off'}">${l.active ? 'active' : 'off'}</span></td>
          <td><button class="btn ghost" data-loedit="${l.id}">Edit</button>
              <button class="btn ghost" data-lodel="${l.id}">Remove</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="empty">No locations yet. Add one for each entrance or area that has a device.</p>'}</div>
    </div>`;

  $('#lo-add').addEventListener('click', async () => {
    if (!$('#lo-name').value.trim()) return toast('Give the location a name');
    await api('/locations', { method: 'POST', body: {
      name: $('#lo-name').value.trim(), description: $('#lo-desc').value.trim(),
      site_id: multiSite ? Number($('#lo-site').value) : (sites[0] ? sites[0].id : null) } });
    render('locations');
  });

  $$('[data-loedit]').forEach((b) => b.addEventListener('click', () => {
    const l = rows.find((x) => String(x.id) === b.dataset.loedit);
    modal(`Edit ${l.name}`, `
      <label class="field"><span>Name</span><input class="input" id="le-name" value="${esc(l.name)}"></label>
      <label class="field"><span>Description</span><input class="input" id="le-desc" value="${esc(l.description || '')}"></label>
      <label class="check"><input type="checkbox" id="le-active" ${l.active ? 'checked' : ''}> Active</label>`,
      async (bg, close) => {
        await api(`/locations/${l.id}`, { method: 'PATCH', body: {
          name: $('#le-name', bg).value, description: $('#le-desc', bg).value, active: $('#le-active', bg).checked } });
        close(); render('locations');
      });
  }));

  $$('[data-lodel]').forEach((b) => b.addEventListener('click', () => confirmAction(
    'Remove this location? Devices and past visits keep working, they just stop being tied to it.',
    async () => { await api(`/locations/${b.dataset.lodel}`, { method: 'DELETE' }); render('locations'); })));
};

/* -------------------------------------------------------------- printers */

const PRINTER_COLORS = [['black', 'Black'], ['red', 'Red'], ['black_red', 'Black & red (DK-2251 roll)']];
const PRINTER_PORTS = [['network', 'Network (Wi-Fi / Ethernet)'], ['wireless_direct', 'Wireless Direct (printer hosts its own Wi-Fi)'],
  ['bluetooth', 'Bluetooth']];
const printerPortLabel = (p) => (PRINTER_PORTS.find(([v]) => v === p) || [p, p])[1];

VIEWS.printers = async (root) => {
  const [rows, locations] = await Promise.all([api('/printers'), api('/locations')]);

  const printerFields = (p) => `
    <div class="form-grid">
      <label class="field"><span>Printer name *</span><input class="input" id="pr-name" placeholder="Gate badge printer" value="${esc(p.name || '')}"></label>
      <label class="field"><span>Model</span><input class="input" id="pr-model" placeholder="Brother QL-820NWB" value="${esc(p.model || '')}"></label>
      <label class="field"><span>Label type</span><input class="input" id="pr-label" placeholder="DK-2251 62mm continuous" value="${esc(p.label_type || '')}"></label>
      <label class="field"><span>Foreground colour</span>
        <select class="input" id="pr-color">${PRINTER_COLORS.map(([v, l]) =>
          `<option value="${v}" ${p.foreground_color === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field"><span>Port</span>
        <select class="input" id="pr-port">${PRINTER_PORTS.map(([v, l]) =>
          `<option value="${v}" ${p.port === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field" id="pr-ip-wrap"><span>Static IP (if set)</span>
        <input class="input" id="pr-ip" placeholder="192.168.1.60" value="${esc(p.ip_address || '')}">
        <span class="muted" id="pr-ip-hint"></span></label>
      <label class="field"><span>Location</span>
        <select class="input" id="pr-loc"><option value="">— none —</option>
          ${locations.map((l) => `<option value="${l.id}" ${p.location_id === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Notes</span><input class="input" id="pr-notes" placeholder="Wireless Direct password, roll spares…" value="${esc(p.notes || '')}"></label>
    </div>
    <label class="check"><input type="checkbox" id="pr-active" ${p.active === 0 ? '' : 'checked'}> In service</label>`;

  // The IP box only means something when the printer is reached by address.
  const wirePortHint = (bg) => {
    const update = () => {
      const port = $('#pr-port', bg).value;
      $('#pr-ip-wrap', bg).style.display = port === 'bluetooth' ? 'none' : '';
      $('#pr-ip-hint', bg).textContent = port === 'wireless_direct'
        ? 'In Wireless Direct the printer is its own network — Brother printers answer at 192.168.118.1.'
        : 'Leave empty if the printer takes an address from your router.';
      if (port === 'wireless_direct' && !$('#pr-ip', bg).value.trim()) $('#pr-ip', bg).value = '192.168.118.1';
    };
    $('#pr-port', bg).addEventListener('change', update);
    update();
  };

  const collect = (bg) => ({
    name: $('#pr-name', bg).value.trim(),
    model: $('#pr-model', bg).value.trim(),
    label_type: $('#pr-label', bg).value.trim(),
    foreground_color: $('#pr-color', bg).value,
    port: $('#pr-port', bg).value,
    ip_address: $('#pr-ip', bg).value.trim(),
    location_id: $('#pr-loc', bg).value ? Number($('#pr-loc', bg).value) : null,
    notes: $('#pr-notes', bg).value.trim(),
    active: $('#pr-active', bg).checked
  });

  root.innerHTML = `
    <h1 class="page">Printers</h1>
    <p class="page-sub">The label printers on site: what they are, which roll is loaded, and how each is reached.
      Point a device at its printer under <b>Devices</b>, and set the badge design under <b>Badges</b>.</p>
    ${locations.length ? '' : '<div class="notice">No locations yet — add them under <b>Locations</b> so each printer can say where it is.</div>'}
    <div class="card section">
      <div class="row" style="margin-bottom:1rem"><button class="btn" id="pr-add">Add printer</button></div>
      <div class="table-wrap">${rows.length ? `<table>
        <thead><tr><th>Printer</th><th>Model</th><th>Label</th><th>Colour</th><th>Port</th><th>Address</th><th>Location</th><th>Devices</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((p) => `<tr>
          <td><b>${esc(p.name)}</b>${p.notes ? `<div class="muted">${esc(p.notes)}</div>` : ''}</td>
          <td class="muted">${esc(p.model || '')}</td>
          <td class="muted">${esc(p.label_type || '')}</td>
          <td class="muted">${esc((PRINTER_COLORS.find(([v]) => v === p.foreground_color) || ['', p.foreground_color])[1])}</td>
          <td class="muted">${esc(printerPortLabel(p.port))}</td>
          <td class="muted">${esc(p.ip_address || (p.port === 'bluetooth' ? '—' : 'auto'))}</td>
          <td class="muted">${esc(p.location_name || '')}</td>
          <td>${p.device_count}</td>
          <td><span class="pill ${p.trouble_since ? 'off' : (p.active ? 'on' : 'off')}">${
p.trouble_since ? 'not printing' : (p.active ? 'in service' : 'out')}</span>${
p.trouble_since
  ? `<div class="muted">Since ${esc(fmtDate(p.trouble_since))}${p.trouble_by ? ` · ${esc(p.trouble_by)}` : ''}${
    p.trouble_note ? `<br>${esc(p.trouble_note)}` : ''}</div>` : ''}</td>
          <td>${p.trouble_since
  ? `<button class="btn ghost" data-prok="${p.id}">Working again</button>`
  : `<button class="btn ghost" data-prdown="${p.id}">Not printing</button>`}
              <button class="btn ghost" data-predit="${p.id}">Edit</button>
              <button class="btn ghost" data-prdel="${p.id}">Remove</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="empty">No printers yet. Add the badge printer so devices can point at it.</p>'}</div>
      <p class="muted">Printing itself runs over AirPrint, so a <b>Network</b> printer just needs to share the tablet's
        Wi-Fi. <b>Wireless Direct</b> is for a tablet on cellular data: the printer hosts its own Wi-Fi and the tablet
        joins it, keeping internet over LTE. A <b>Bluetooth</b> entry is inventory only — iPads can only print over
        Bluetooth from the maker's own app, not from the kiosk.</p>
      <p class="muted">To prove a printer actually works, open <code class="token">/check/</code> on the tablet
        that has it — not on this computer, which would print to its own printer. That page prints a test badge
        and an alignment page, and checks the tablet can still reach the server after joining a printer's own
        Wi-Fi, which is the failure that otherwise goes unnoticed. There is a code to scan it with under
        <b>Badges → Label size</b>.</p>
    </div>`;

  $('#pr-add').addEventListener('click', () => {
    const m = modal('Add printer', printerFields({ foreground_color: 'black', port: 'network', active: 1 }),
      async (bg, close) => {
        const body = collect(bg);
        if (!body.name) return toast('Give the printer a name');
        await api('/printers', { method: 'POST', body });
        close(); render('printers');
      });
    wirePortHint(m.bg);
  });

  $$('[data-predit]').forEach((b) => b.addEventListener('click', () => {
    const p = rows.find((x) => String(x.id) === b.dataset.predit);
    const m = modal(`Edit ${p.name}`, printerFields(p), async (bg, close) => {
      const body = collect(bg);
      if (!body.name) return toast('Give the printer a name');
      await api(`/printers/${p.id}`, { method: 'PATCH', body });
      close(); render('printers');
    });
    wirePortHint(m.bg);
  }));

  $$('[data-prdel]').forEach((b) => b.addEventListener('click', () => confirmAction(
    'Remove this printer? Devices pointed at it simply lose the link.',
    async () => { await api(`/printers/${b.dataset.prdel}`, { method: 'DELETE' }); render('printers'); })));

  /*
   * Marking a printer as not printing, and marking it fixed. Both are a
   * person's judgement rather than anything observed — nothing here can
   * reach the printer — so the wording asks what they saw rather than
   * announcing a fault, and the optional note is the difference between
   * "somebody will look at it" and "it needs a new roll".
   */
  $$('[data-prdown]').forEach((b) => b.addEventListener('click', () => {
    const bg = modal('Badges are not printing', `
      <p class="muted" style="margin-top:0">This tells the dashboard, the on-site board and your chat
        channel at once, so nobody else has to work it out at the gate. Sign-ins carry on as normal —
        only the badge is missing.</p>
      <label class="field"><span>What is wrong, if you know</span>
        <input class="input" id="pr-note" placeholder="Out of labels, switched off, offline…"></label>`,
    async (box, close) => {
      await api(`/printers/${b.dataset.prdown}/trouble`,
        { method: 'POST', body: { note: $('#pr-note', box).value.trim() || null } });
      close();
      render('printers');
    }, 'Mark it');
    const note = $('#pr-note', bg);
    if (note) note.focus();
  }));

  $$('[data-prok]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/printers/${b.dataset.prok}/working`, { method: 'POST' });
    toast('Marked as working again');
    render('printers');
  }));
};

/* -------------------------------------------------------------- devices */

const CAMERA_LABEL = { front: 'Front camera', rear: 'Rear camera' };

// The home-screen cards a device can be limited to — the fixed ones plus
// whatever visitor types currently have their own card.
const DEVICE_SECTIONS = () => [
  ['signin', 'Sign in'], ['signout', 'Sign out'],
  ...((SETTINGS && SETTINGS.types) || []).filter((ty) => ty.mode === 'card' || ty.mode === 'both')
    .map((ty) => [ty.key, ty.label]),
  ['delivery', 'Delivery'], ['unlock', 'Request entry']
];

VIEWS.devices = async (root) => {
  const [rows, locations, printers] = await Promise.all([api('/devices'), api('/locations'), api('/printers')]);
  const origin = location.origin;
  root.innerHTML = `
    <h1 class="page">Devices</h1>
    <p class="page-sub">Every tablet or screen running Smart Lobby. Register one here, then open its link on the device
      and add it to the home screen.</p>
    ${locations.length ? '' : `<div class="notice">No locations yet — add them under <b>Locations</b> first so each
      device can say where it is.</div>`}
    <div class="card section">
      <div class="inline-form" style="margin-bottom:1rem">
        <label class="field"><span>Device name</span><input class="input" id="dv-name" placeholder="Reception iPad"></label>
        <label class="field"><span>Location</span><select class="input" id="dv-loc">
          <option value="">— none —</option>
          ${locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
        <button class="btn" id="dv-add">Register device</button>
      </div>
      <div class="table-wrap">${rows.length ? `<table>
        <thead><tr><th>Name</th><th>Device link</th><th>Location</th><th>Camera</th><th>Mode</th><th>Printing</th><th>Last seen</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((d) => {
          const online = d.last_seen_at && (Date.now() - new Date(d.last_seen_at).getTime()) < 5 * 60000;
          return `<tr>
            <td><b>${esc(d.name)}</b></td>
            <td><code class="token">/kiosk/${esc(d.slug || '')}</code></td>
            <td>${esc(d.location_name || '—')}</td>
            <td>${esc(cameraName(d))}</td>
            <td>${esc(d.mode || 'kiosk')}</td>
            <td><span class="pill ${d.print_enabled ? 'on' : 'off'}">${d.print_enabled ? 'on' : 'off'}</span></td>
            <td>${fmtDate(d.last_seen_at)}</td>
            <td><span class="pill ${online ? 'on' : 'off'}">${online ? 'online' : 'offline'}</span></td>
            <td><button class="btn ghost" data-dvcopy="${d.id}">Copy link</button>
                <button class="btn ghost" data-dvqr="${d.id}">QR</button>
                <button class="btn ghost" data-dvedit="${d.id}">Edit</button>
                <button class="btn ghost" data-dvlink="${d.id}">Link</button>
                <button class="btn ghost" data-dvdel="${d.id}">Remove</button></td></tr>`;
        }).join('')}</tbody></table>` : '<p class="empty">No devices registered yet.</p>'}</div>
    </div>`;

  /*
   * Each tablet has its own address. It is the whole link — not a token
   * tucked in a query parameter — so saving it to an iPad's home screen keeps
   * this device's cards. A saved icon used to come back to the shared page
   * showing everything, because the token never survived the trip.
   */
  const deviceUrl = (d) => `${origin}/kiosk/${d.slug || ''}`;

  const showLink = (d) => {
    const url = deviceUrl(d);
    const { bg } = modal(`${d.name} — device link`, `
      <p>Open this on the tablet:</p>
      <div class="copy-row">
        <code class="token" id="dv-url">${esc(url)}</code>
        <button class="btn" id="dv-copy">Copy link</button>
      </div>
      <p class="muted">On the iPad, open it in Safari, then <b>Share → Add to Home Screen</b>. The icon is named
        after this device and reopens on this page, so it always shows this device's cards — no Wi-Fi or sign-in
        needed to get back to it.</p>
      <p class="muted">The tablet reports in every minute, so this page shows whether it is online. Rename the
        device freely; its link only changes if you change it under Edit.</p>
      <details><summary class="muted">Older token link (still works)</summary>
        <div class="copy-row" style="margin-top:0.5rem">
          <code class="token">${origin}/kiosk/?token=${d.token}</code>
          <button class="btn ghost" id="dv-copy-token">Copy</button>
        </div>
        <p class="muted">Kept so links already handed out keep working. A tablet opened this way moves itself onto
          the address above, so anything saved to the home screen from then on is the durable one.</p>
      </details>`, null);
    $('#dv-copy', bg).addEventListener('click', (e) => copyText(url, e.currentTarget));
    $('#dv-copy-token', bg).addEventListener('click', (e) =>
      copyText(`${origin}/kiosk/?token=${d.token}`, e.currentTarget));
  };

  $('#dv-add').addEventListener('click', async () => {
    const d = await api('/devices', { method: 'POST', body: {
      name: $('#dv-name').value || 'Reception kiosk', location_id: $('#dv-loc').value || null } });
    showLink(d);
    render('devices');
  });

  $$('[data-dvlink]').forEach((b) => b.addEventListener('click', () =>
    showLink(rows.find((x) => String(x.id) === b.dataset.dvlink))));

  /*
   * The links as codes, to point a camera at.
   *
   * Two of them, and they are not interchangeable: the tablet's own address,
   * for setting a tablet up without typing it; and the phone check-in
   * address, which goes on a sign at the gate for visitors to scan.
   */
  $$('[data-dvqr]').forEach((b) => b.addEventListener('click', async () => {
    const device = rows.find((x) => String(x.id) === b.dataset.dvqr);
    let links;
    try { links = await api(`/devices/${device.id}/links`); }
    catch { return toast('Could not read that device’s links'); }

    const block = (title, url, note) => `
      <div class="qr-block">
        <h3>${esc(title)}</h3>
        <img class="qr-img" src="/api/qr?text=${encodeURIComponent(url)}" alt="">
        <p class="muted qr-url"><code class="token">${esc(url)}</code></p>
        <p class="muted">${note}</p>
      </div>`;

    modal(`${device.name} — links`, `
      ${block('This tablet', links.kiosk,
  'Open this on the tablet, then Add to Home Screen. It always comes back showing this device’s cards.')}
      ${links.self
  ? block('Check in from a phone', links.self,
    'Print this and put it where visitors arrive. Scanning it opens the sign-in on their own phone.'
    + (links.geofence.enabled
      ? ` Sign-ins are refused more than ${links.geofence.radius_m} m from the site.`
      : ' <b>No site location is set</b>, so this is not limited to people who are actually here — '
        + 'set one under Settings → Kiosk sign-in flow.'))
  : `<div class="notice"><b>Phone check-in is off for this device.</b> Turn it on with
       <b>Edit</b>, and switch it on for the site under
       <b>Settings → Kiosk sign-in flow</b>.</div>`}
      ${links.self ? `<div class="row"><button class="btn" id="qr-print">Print the sign</button>
        <span class="muted">Opens a ready-made sign — print it, or save it as a PDF.</span></div>
        <div class="row"><button class="btn ghost" id="qr-reissue">Reissue the phone link</button>
        <span class="muted">Every printed sign stops working.</span></div>` : ''}`, null);

    /*
     * A new tab rather than printing from here: this modal sits inside the
     * dashboard, and printing it would print the dashboard around it.
     */
    const printSign = $('#qr-print');
    if (printSign) {
      printSign.addEventListener('click', () =>
        window.open(`/api/admin/devices/${device.id}/sign`, '_blank', 'noopener'));
    }

    const reissue = $('#qr-reissue');
    if (reissue) {
      reissue.addEventListener('click', async () => {
        if (!confirm('Issue a new phone check-in link? Every sign already printed will stop working.')) return;
        await api(`/devices/${device.id}/self-code`, { method: 'POST' });
        toast('New link issued — reprint the sign');
        $$('.modal-bg [data-close]').forEach((x) => x.click());
      });
    }
  }));

  // One press, straight from the list — the common case is emailing a link to
  // whoever is standing at the tablet.
  $$('[data-dvcopy]').forEach((b) => b.addEventListener('click', () =>
    copyText(deviceUrl(rows.find((x) => String(x.id) === b.dataset.dvcopy)), b)));

  $$('[data-dvedit]').forEach((b) => b.addEventListener('click', () => {
    const d = rows.find((x) => String(x.id) === b.dataset.dvedit);
    let reported = [];
    try { reported = JSON.parse(d.cameras || '[]'); } catch { reported = []; }

    // This device's card list: the saved order first, then anything it has not
    // been told about, so a newly added card is offered rather than lost.
    let saved = null;
    try { saved = JSON.parse(d.sections || 'null'); } catch { saved = null; }
    const known = DEVICE_SECTIONS().map(([key]) => key);
    const sectionOrder = Array.isArray(saved) && saved.length
      ? [...new Set([...saved.filter((k) => known.includes(k)), ...known])]
      : known.slice();
    const enabled = new Set(Array.isArray(saved) && saved.length ? saved : known);
    const options = [['front', 'Front camera'], ['rear', 'Rear camera'],
      ...reported.map((c) => [c.id, c.label])];

    const m = modal(`Edit ${d.name}`, `
      <div class="form-grid">
        <label class="field"><span>Device name</span><input class="input" id="de-name" value="${esc(d.name)}"></label>
        <label class="field"><span>Device link</span><input class="input" id="de-slug" value="${esc(d.slug || '')}">
          <small class="muted">The tablet's own address: ${esc(origin)}/kiosk/<b id="de-slug-preview">${esc(d.slug || '')}</b>.
            Changing it breaks any icon already saved to a home screen, so leave it alone once the tablet is set up.</small></label>
        <label class="field"><span>Location</span><select class="input" id="de-loc">
          <option value="">— none —</option>
          ${locations.map((l) => `<option value="${l.id}" ${l.id === d.location_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select></label>
        <label class="field"><span>Default camera</span><select class="input" id="de-cam">
          ${options.map(([v, l]) => `<option value="${esc(v)}" ${d.default_camera === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select></label>
        <label class="field"><span>Operational mode</span><select class="input" id="de-mode">
          <option value="kiosk" ${d.mode === 'kiosk' ? 'selected' : ''}>Kiosk — visitor sign-in</option>
        </select></label>
      </div>

      <h3>Cards on this device</h3>
      <p class="muted" style="margin-top:0">Which cards this kiosk shows, and the order they appear in. A warehouse
        gate can lead with Driver while reception leads with Sign in. Untick a card to hide it here without
        affecting other devices.</p>
      <div id="de-sections" class="section-order"></div>
      <p class="muted">With everything ticked in the standard order, this device shows whatever is switched on in
        Settings — including any card added later.</p>
      <p class="muted">${reported.length
        ? `${reported.length} camera${reported.length === 1 ? '' : 's'} reported by this device.`
        : 'This device has not reported its cameras yet — it does so once it has been opened and allowed camera access. Front/rear still work.'}</p>
      <label class="check"><input type="checkbox" id="de-print" ${d.print_enabled ? 'checked' : ''}>
        <span>Print badges from this device<br><span class="muted">Only applies while badge printing is on in
          Settings. Turn it off for a device with no printer attached.</span></span></label>
      <label class="field"><span>Printer beside this device</span><select class="input" id="de-printer">
        <option value="">— none —</option>
        ${printers.map((p) => `<option value="${p.id}" ${p.id === d.printer_id ? 'selected' : ''}>${esc(p.name)}${p.model ? ` (${esc(p.model)})` : ''}</option>`).join('')}
      </select>
      <span class="muted">From the Printers tab — records which printer this tablet prints to.</span></label>
      <label class="check"><input type="checkbox" id="de-self" ${d.self_checkin ? 'checked' : ''}>
        <span>Offer check-in from a phone<br><span class="muted">Produces a second link, and a QR code to
          print for the gate. Visitors scan it and sign in on their own phone. Also needs switching on for
          the site under <b>Settings → Kiosk sign-in flow</b>, where the site location is set.</span></span></label>
      <p class="muted">More operational modes are coming; every device runs in kiosk mode for now.</p>`,
      async (bg, close) => {
        const picked = sectionOrder.filter((k) => enabled.has(k));
        const defaults = DEVICE_SECTIONS();
        const isDefault = picked.length === defaults.length
          && picked.every((k, i) => k === defaults[i][0]);
        const slug = $('#de-slug', bg).value.trim();
        await api(`/devices/${d.id}`, { method: 'PATCH', body: {
          name: $('#de-name', bg).value,
          // Only sent when it was actually edited: a rename must not quietly
          // move a tablet whose link is already on someone's home screen.
          ...(slug && slug !== (d.slug || '') ? { slug } : {}),
          location_id: $('#de-loc', bg).value || null,
          default_camera: $('#de-cam', bg).value,
          mode: $('#de-mode', bg).value,
          // Everything ticked in the standard order means "no preference", so a
          // card added later still appears on this device.
          sections: isDefault ? null : JSON.stringify(picked),
          print_enabled: $('#de-print', bg).checked,
          self_checkin: $('#de-self', bg).checked,
          printer_id: $('#de-printer', bg).value ? Number($('#de-printer', bg).value) : null } });
        close(); render('devices');
      });

    // Show what the address will actually become as it is typed.
    $('#de-slug', m.bg).addEventListener('input', (e) => {
      $('#de-slug-preview', m.bg).textContent = e.target.value.trim()
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    });

    const drawSections = () => {
      const box = $('#de-sections', m.bg);
      const label = (k) => (DEVICE_SECTIONS().find(([key]) => key === k) || [k, k])[1];
      box.innerHTML = sectionOrder.map((key, i) => `<div class="section-row${enabled.has(key) ? '' : ' off'}">
        <label class="check"><input type="checkbox" data-dsec="${key}" ${enabled.has(key) ? 'checked' : ''}>
          <span>${i + 1}. ${esc(label(key))}</span></label>
        <span class="flow-moves">
          <button class="btn ghost" type="button" data-secup="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn ghost" type="button" data-secdown="${i}" ${i === sectionOrder.length - 1 ? 'disabled' : ''}>↓</button>
        </span></div>`).join('');

      $$('[data-dsec]', box).forEach((c) => c.addEventListener('change', () => {
        if (c.checked) enabled.add(c.dataset.dsec); else enabled.delete(c.dataset.dsec);
        drawSections();
      }));
      $$('[data-secup]', box).forEach((btn) => btn.addEventListener('click', () => {
        const i = Number(btn.dataset.secup);
        [sectionOrder[i - 1], sectionOrder[i]] = [sectionOrder[i], sectionOrder[i - 1]];
        drawSections();
      }));
      $$('[data-secdown]', box).forEach((btn) => btn.addEventListener('click', () => {
        const i = Number(btn.dataset.secdown);
        [sectionOrder[i + 1], sectionOrder[i]] = [sectionOrder[i], sectionOrder[i + 1]];
        drawSections();
      }));
    };
    drawSections();
  }));

  $$('[data-dvdel]').forEach((b) => b.addEventListener('click', () => confirmAction(
    'Remove this device? Its kiosk link stops working.',
    async () => { await api(`/devices/${b.dataset.dvdel}`, { method: 'DELETE' }); render('devices'); })));
};

function cameraName(d) {
  const choice = d.default_camera || 'front';
  if (CAMERA_LABEL[choice]) return CAMERA_LABEL[choice];
  try {
    const found = JSON.parse(d.cameras || '[]').find((c) => c.id === choice);
    if (found) return found.label;
  } catch { /* no cameras reported */ }
  return 'Specific camera';
}

