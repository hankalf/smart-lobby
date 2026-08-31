'use strict';
/*
 * The device check, in a file of its own rather than inline.
 *
 * Not a style preference. The site sends Content-Security-Policy with
 * script-src 'self', which blocks inline script outright — so this page ran
 * none of its own checks at all. It rendered its headings and buttons and did
 * nothing else, and the guides had been sending people here to find out why
 * the camera would not work.
 *
 * Keep it external. An inline block here is broken the moment it is written.
 */
(() => {
  const results = document.getElementById('results');

  /*
   * First thing, before anything that could throw: clear the "did not run"
   * notice. Its whole job is to still be there if this line is never reached.
   */
  const notice = document.getElementById('did-not-run');
  if (notice) notice.remove();

  /*
   * Which build is answering. The common question after a deploy is not "is
   * the server up" but "is it running the version I just pushed", and until
   * this was here nothing on the site could tell you.
   */
  fetch('/api/health', { cache: 'no-store' })
    .then((r) => r.json())
    .then((h) => {
      const build = h.build || {};
      document.getElementById('build-note').innerHTML = build.commit
        ? `Build <code>${build.commit}</code>, running since ${new Date(build.started_at).toLocaleString()}.`
        : `Running since ${new Date(build.started_at || Date.now()).toLocaleString()}. `
          + 'No build id — this server was not deployed from a git checkout.';
    })
    .catch(() => {
      document.getElementById('build-note').textContent =
        'Could not ask the server which version it is — see the connection test below.';
    });

  const add = (state, what, why) => {
    const mark = state === 'pass' ? '✓' : state === 'fail' ? '✕' : '!';
    results.insertAdjacentHTML('beforeend',
      `<div class="row"><div class="mark ${state}">${mark}</div>
       <div><div class="what">${what}</div><div class="why">${why}</div></div></div>`);
  };

  document.getElementById('ua').textContent = navigator.userAgent;

  // Secure context — everything camera-related depends on it.
  if (window.isSecureContext) {
    add('pass', 'Secure connection', 'The camera is allowed to work on this address.');
  } else {
    add('fail', 'Not a secure connection',
      `This page is on ${location.protocol}//. Browsers only allow the camera over https:// or on localhost, ` +
      'so the selfie step and the badge scanner cannot run here.');
  }

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    add('pass', 'Camera interface present', 'This browser exposes a camera to web pages. Press “Test the camera” to prove it works.');
  } else {
    add('fail', 'No camera interface',
      'This browser gives web pages no way to reach the camera at all. In a kiosk app this usually means the app ' +
      'does not support it — Safari with Guided Access does.');
  }

  add('BarcodeDetector' in window ? 'pass' : 'warn',
    'BarcodeDetector' in window ? 'Built-in barcode reader' : 'No built-in barcode reader',
    'BarcodeDetector' in window
      ? 'QR codes are read by the browser itself.'
      : 'Normal on iPad — Smart Lobby loads its own reader instead, which works the same.');

  try {
    localStorage.setItem('sl_check', '1'); localStorage.removeItem('sl_check');
    add('pass', 'Local storage', 'The kiosk can remember which device it is.');
  } catch {
    add('fail', 'Local storage blocked', 'The kiosk cannot remember which device it is, so it will not report in.');
  }

  /*
   * Said carefully. Every browser has window.print, so its presence proves
   * only that a dialog can be opened — not that a printer is reachable, and
   * certainly not that a label comes out the right size. The page used to
   * report this as "Badges can be sent to a printer", which is a claim it has
   * no way to check, and the only test that settles it is printing one.
   */
  add(typeof window.print === 'function' ? 'pass' : 'fail', 'A print dialog can be opened',
    typeof window.print === 'function'
      ? 'Which is all this can tell from here — whether a badge comes out the right size is the test below.'
      : 'This browser gives web pages no way to print at all, so badges cannot be printed from the kiosk.');

  add(window.navigator.standalone ? 'pass' : 'warn',
    window.navigator.standalone ? 'Running full screen' : 'Running in a browser tab',
    window.navigator.standalone ? 'Added to the home screen.' : 'Fine for testing. For a real kiosk, add it to the home screen.');

  document.getElementById('test-camera').addEventListener('click', async () => {
    const note = document.getElementById('camera-note');
    note.textContent = 'Asking for the camera…';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      const video = document.getElementById('cam');
      video.srcObject = stream;
      await video.play().catch(() => {});
      setTimeout(() => {
        note.textContent = video.videoWidth
          ? `Camera works — ${video.videoWidth}×${video.videoHeight}. The selfie step and badge scanner will both run here.`
          : 'The camera opened but sent no picture. This usually means the app is blocking playback.';
        note.className = 'why';
      }, 1200);
    } catch (err) {
      note.innerHTML = `<b>The camera was refused:</b> ${err.name} — ${err.message}.<br>` +
        'If this is a kiosk app, it probably does not pass camera permission through to web pages. ' +
        'Safari with Guided Access does, and so does adding the kiosk to the home screen.';
    }
  });

  /* ------------------------------------------------------ the badge printer */

  const printNote = document.getElementById('print-note');
  const sheet = document.getElementById('badge-sheet');

  /*
   * Printed at the size this site is actually configured for, read from the
   * kiosk config — a test badge on A4 defaults would prove nothing about a
   * 62 mm roll, which is the whole question being asked.
   */
  async function badgeSetup() {
    const cfg = await fetch('/api/kiosk/config', { cache: 'no-store' }).then((r) => r.json());
    const badge = (cfg && cfg.badge) || {};
    const w = Number(badge.label_width_mm) || 62;
    const h = Number(badge.label_height_mm) || 100;
    const landscape = badge.orientation === 'landscape';
    const root = document.documentElement;
    root.style.setProperty('--badge-w', `${w}mm`);
    root.style.setProperty('--badge-h', `${h}mm`);
    root.style.setProperty('--card-w', `${landscape ? h : w}mm`);
    root.style.setProperty('--card-h', `${landscape ? w : h}mm`);
    root.style.setProperty('--card-turn', landscape ? `translateX(${w}mm) rotate(90deg)` : 'none');
    root.style.setProperty('--badge-scale', badge.font_scale || 1);
    return { w, h, landscape, badge };
  }

  document.getElementById('test-badge').addEventListener('click', async () => {
    printNote.textContent = 'Reading this site’s badge size…';
    let setup;
    try {
      setup = await badgeSetup();
    } catch (err) {
      printNote.innerHTML = '<b>Could not read the badge settings from the server.</b> '
        + 'Check the connection test below before blaming the printer.';
      return;
    }

    const when = new Date();
    sheet.querySelector('.badge-meta').innerHTML =
      `${when.toLocaleDateString()}<br>${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    /*
     * Printed on the badge itself, so a label found on a desk a week later
     * still says what it was meant to be. Inches alongside millimetres because
     * label stock is sold in both and the person holding the ruler has one or
     * the other.
     */
    const inches = (mm) => (mm / 25.4).toFixed(2);
    document.getElementById('intended-size').textContent =
      `${setup.w} × ${setup.h} mm (${inches(setup.w)} × ${inches(setup.h)} in)`
      + `${setup.landscape ? ', turned sideways' : ''}`;
    sheet.querySelector('.badge-foot').textContent = 'Device check — not a real visitor';
    // The QR is the slowest part of a real badge and the thing most likely to
    // come out blank, so the test badge carries one too.
    sheet.querySelector('.badge-qr').innerHTML =
      '<img src="/api/qr?text=DEVICE-CHECK" alt="">';

    const img = sheet.querySelector('.badge-qr img');
    await new Promise((done) => {
      if (img.complete) return done();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      setTimeout(done, 3000);
    });

    printNote.innerHTML = `Printing at <b>${setup.w} × ${setup.h} mm</b>`
      + `${setup.landscape ? ', turned sideways' : ''}. In the dialog: margins <b>None</b>, `
      + 'headers and footers <b>off</b>, and <b>no scaling</b> if it is offered.'
      + '<br><br><b>Then measure the two rulers on the label</b>, not the label itself:'
      + '<br>• Both correct — the badge is printing true, and any leftover label is just the roll.'
      + '<br>• Both long or both short by the same amount — it is being scaled. Divide to get the'
      + ' factor and set the label size to match your real stock.'
      + '<br>• The rulers run <i>along</i> the roll instead of across it — the printer turned the'
      + ' badge. Switch <b>Which way it prints</b> under Badges, rather than swapping the numbers.'
      + '<br>• A corner mark missing — it is being cropped, not scaled. The badge is bigger than'
      + ' the printable area.';

    sheet.hidden = false;
    sheet.setAttribute('data-printing', '');
    window.print();
    // Put the page back however the dialog ended — printed or cancelled.
    setTimeout(() => { sheet.removeAttribute('data-printing'); sheet.hidden = true; }, 500);
  });

  document.getElementById('test-print').addEventListener('click', () => window.print());

  /* ------------------------------------------------------- the alignment page */

  const alignSheet = document.getElementById('align-sheet');
  const alignNote = document.getElementById('align-note');
  const STEP = 2;   // millimetres between marks — fine enough to set a margin by

  /**
   * A numbered scale, drawn in the same millimetres the badge is laid out in.
   *
   * Every second mark is numbered, so the page stays readable on a 62 mm label
   * without the numbers running into each other. The mark at zero is where the
   * printer *believes* the label starts, so how much of the low end is missing
   * is as informative as where the high end stops.
   */
  function scale(into, extent, axis) {
    const bits = [];
    for (let at = 0; at <= extent; at += STEP) {
      const where = axis === 'across' ? `left:${at}mm` : `top:${at}mm`;
      bits.push(`<s style="${where}"></s>`);
      if (at % (STEP * 2) === 0) bits.push(`<b style="${where}">${at}</b>`);
    }
    into.innerHTML = bits.join('');
  }

  let alignFor = null;
  document.getElementById('print-align').addEventListener('click', async () => {
    alignNote.textContent = 'Reading this site’s label size…';
    try {
      alignFor = await badgeSetup();
    } catch {
      alignNote.textContent = 'Could not read the label settings from the server.';
      return;
    }
    // The scales run the full intended size, so a mark that does not appear on
    // the label is exactly the part the printer cannot reach.
    scale(document.getElementById('align-scale-across'), alignFor.w, 'across');
    scale(document.getElementById('align-scale-down'), alignFor.h, 'down');

    alignNote.innerHTML = `Printing a scale to <b>${alignFor.w} × ${alignFor.h} mm</b>. `
      + 'Margins <b>None</b>, no scaling. Then read the last number fully on the label in each '
      + 'direction and type them in above.';

    alignSheet.hidden = false;
    alignSheet.setAttribute('data-printing', '');
    window.print();
    setTimeout(() => { alignSheet.removeAttribute('data-printing'); alignSheet.hidden = true; }, 500);
  });

  document.getElementById('align-apply').addEventListener('click', () => {
    const across = Number(document.getElementById('align-across').value);
    const down = Number(document.getElementById('align-down').value);
    if (!alignFor) return void (alignNote.textContent = 'Print the alignment page first.');
    if (!Number.isFinite(across) || !Number.isFinite(down) || across <= 0 || down <= 0) {
      alignNote.textContent = 'Type the last number you can read in each direction.';
      return;
    }

    /*
     * What the numbers mean. The scale was drawn to the full intended size, so
     * a last-readable number below that size is the printable area falling
     * short — the difference is what the printer cannot reach, and half of it
     * at each end is the margin to set. Rounded up to the next whole
     * millimetre, because a margin that is exactly the unprintable width puts
     * the badge's edge on the boundary and prints a hairline or nothing
     * depending on the day.
     */
    const shortAcross = Math.max(0, alignFor.w - across);
    const shortDown = Math.max(0, alignFor.h - down);
    const side = Math.ceil(shortAcross / 2);
    const ends = Math.ceil(shortDown / 2);

    if (shortAcross === 0 && shortDown === 0) {
      alignNote.innerHTML = '<b class="pass">The whole label is printable.</b> Nothing to correct — '
        + 'any margin you set now is for looks rather than for the printer.';
      return;
    }

    alignNote.innerHTML = `The printer reaches <b>${across} × ${down} mm</b> of a `
      + `<b>${alignFor.w} × ${alignFor.h} mm</b> label — it cannot print `
      + `${shortAcross} mm across or ${shortDown} mm down.<br><br>`
      + `Set the margins under <b>Badges → Label size</b> to at least `
      + `<b>${side} mm</b> left and right, and <b>${ends} mm</b> top and bottom. `
      + 'Then print a test badge and check all four corner marks are on the label.'
      + (Math.abs(side - ends) >= 2
        ? '<br><br>The two differ enough to be worth setting per side rather than one number all round — '
          + 'which is normal on a continuous roll, where the cut edges and the side edges behave differently.'
        : '');
  });

  /* --------------------------------------------------- reaching the server */

  const reachNote = document.getElementById('reach-note');
  document.getElementById('test-reach').addEventListener('click', async () => {
    reachNote.textContent = 'Asking the server…';
    const started = Date.now();
    try {
      /*
       * Timed out by hand rather than left to the browser. The failure this is
       * looking for — a request leaving over a Wi-Fi network with no route out
       * — does not refuse, it hangs, and a spinner that never resolves is the
       * least useful thing to hand somebody standing at a gate.
       */
      const bail = new AbortController();
      const timer = setTimeout(() => bail.abort(), 8000);
      const res = await fetch(`/api/health?t=${Date.now()}`, { cache: 'no-store', signal: bail.signal });
      clearTimeout(timer);
      const ms = Date.now() - started;
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      reachNote.innerHTML = `<b class="pass">Reached the server in ${ms} ms.</b> `
        + `${body && body.storage === 'ephemeral'
          ? '<b class="fail">But storage is not persistent — see the dashboard.</b>'
          : 'Sign-ins made on this tablet will be recorded.'}`;
    } catch (err) {
      const ms = Date.now() - started;
      reachNote.innerHTML = `<b class="fail">Could not reach the server</b> (${err.name === 'AbortError'
        ? 'no answer in 8 seconds' : err.message}, after ${ms} ms).<br>`
        + 'If this tablet is joined to the printer’s own Wi-Fi, that network has no way out to the '
        + 'internet and the tablet is trying to use it anyway. Forget the printer’s network, confirm '
        + 'this test passes on cellular, then rejoin it — iOS keeps internet on cellular once it has '
        + 'learned that the Wi-Fi has none. Until this passes, the kiosk cannot record sign-ins.';
    }
  });
})();
