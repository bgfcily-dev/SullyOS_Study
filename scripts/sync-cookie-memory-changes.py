"""Refresh shared memory modules in an already-integrated Cookie checkout."""
from pathlib import Path
import argparse
import shutil
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--cookie-root', required=True, type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
cookie = args.cookie_root.resolve(strict=True)
if not (cookie / 'src/LiteApp.tsx').is_file() or not (cookie / 'package.json').is_file():
    parser.error('Target must be a Cookie checkout with src/LiteApp.tsx')
if 'MemoryChangeReview' not in (cookie / 'src/LiteApp.tsx').read_text(encoding='utf-8'):
    parser.error('Integrate the review entry points before refreshing shared modules')
targets = {}
for name in ['changeContract.ts', 'changeClient.ts', 'currentState.ts']:
    targets[cookie / 'src/shared/memoryPalace' / name] = root / 'utils/memoryPalace' / name
for name in ['index.ts', 'memoryChanges.ts', 'eventBoxRetirement.ts', 'index.test.ts', 'metadata.test.ts']:
    targets[cookie / 'worker/memory-sync/src' / name] = root / 'worker/memory-sync/src' / name
targets[cookie / 'worker/memory-sync/schema.sql'] = root / 'worker/memory-sync/schema.sql'
for name in ['changeContract.ts', 'metadata.ts']:
    targets[cookie / 'utils/memoryPalace' / name] = root / 'utils/memoryPalace' / name
contents = {target: source.read_text(encoding='utf-8') for target, source in targets.items()}
contents[cookie / 'src/components/MemoryChangeReview.tsx'] = (root / 'components/chat/MemoryChangeReview.tsx').read_text(encoding='utf-8').replace('../../utils/memoryPalace/', '../shared/memoryPalace/').replace('import React, {', 'import {')
contents[cookie / 'src/memoryState.ts'] = (root / 'lite/memoryState.ts').read_text(encoding='utf-8').replace('../utils/memoryPalace/', './shared/memoryPalace/')
changed = {target: content for target, content in contents.items() if not target.exists() or target.read_text(encoding='utf-8') != content}
if changed:
    backup = Path(tempfile.mkdtemp(prefix='cookie-before-memory-sync-'))
    for target, content in changed.items():
        if target.exists():
            saved = backup / target.relative_to(cookie)
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, saved)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8', newline='\n')
    print(f'Refreshed {len(changed)} shared modules. Backup: {backup}')
else:
    print('Shared memory modules already match.')
