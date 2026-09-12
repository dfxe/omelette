// Test entry point. Invoke through run.sh, which sets up the sandboxed
// XDG_DATA_HOME the vaultStore tests require:
//
//     linux/tests/run.sh
//
// Every module covered here is free of resource:/// imports, so it loads
// outside gnome-shell with no Shell and no display. Anything touching
// St/Clutter/PanelMenu cannot be tested this way and is checked in a nested
// shell instead — see the README's development section.

import System from 'system';

import './match.test.js';
import './units.test.js';
import './format.test.js';
import './calc.test.js';
import './configStore.test.js';
import './searchRegistry.test.js';
import './sensors.test.js';
import './pdfExtract.test.js';
import './pdfProvider.test.js';
import './awake.test.js';
import './awakeProvider.test.js';
import './editShapes.test.js';
import './editPalette.test.js';
import './editExport.test.js';
import './dataDir.test.js';
import './vaultStore.test.js';

import { report } from './harness.js';

System.exit(report());
