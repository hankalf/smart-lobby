/*
 * Smart Lobby admin.
 *
 * This file exists to bring the pages in and start. Each import registers its
 * own pages in VIEWS as it evaluates, so nothing here has to list them.
 */
import { showGate, start } from './core.js';
import './people.js';
import './setup.js';
import './site.js';
import './records.js';
import './settings.js';

const boot = await fetch('/api/admin/bootstrap').then((r) => r.json()).catch(() => null);
if (!boot || boot.needs_setup || !boot.user) showGate();
else start();
