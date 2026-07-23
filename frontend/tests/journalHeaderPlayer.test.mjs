import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read=(p)=>readFileSync(new URL(`../src/${p}`,import.meta.url),'utf8');
test('journal header exposes accessible Logs and Player controls and removes inline panels',()=>{const page=read('pages/JournalPage.tsx');assert.match(page,/aria-label="Open journal pipeline logs"/);assert.match(page,/aria-label="Open Daily Mindscape player"/);assert.doesNotMatch(page,/<JournalRunsPanel\s*\/>/)});
test('private player never opts into autoplay and uses authenticated audio route',()=>{const player=read('components/MindscapePanel.tsx');const post=read('pages/JournalPostPage.tsx');assert.doesNotMatch(player,/autoPlay/);assert.doesNotMatch(post,/autoPlay/);assert.match(player,/authenticatedFetch\(`\$\{API\}\/journal\/mindscape/);assert.match(player,/URL\.revokeObjectURL/)});
test('drawers provide dialog semantics, Escape handling and mobile sheet CSS',()=>{const drawer=read('components/JournalLogsDrawer.tsx');const css=read('components/JournalDrawer.css');assert.match(drawer,/role="dialog"/);assert.match(drawer,/e\.key==='Escape'/);assert.match(drawer,/previousFocus|prior/);assert.match(css,/@media\(max-width:600px\)/)});
test('visual-system controls define styled interactive states and responsive labels',()=>{const page=read('pages/JournalPage.tsx');const pageCss=read('pages/JournalPage.css');const playerCss=read('components/MindscapePanel.css');assert.match(page,/journal-header-tool-primary/);assert.match(page,/aria-pressed=/);assert.match(pageCss,/\.journal-header-tool\{[^}]*background:/);assert.match(pageCss,/\.journal-header-tool:hover/);assert.match(pageCss,/\.journal-header-tool:focus-visible/);assert.match(playerCss,/\.icon-touch:disabled/);assert.match(playerCss,/\.mindscape-alert/);assert.match(playerCss,/@media\(prefers-reduced-motion:reduce\)/)});
test('mindscape presents human-readable dates, explicit loading and polished empty states',()=>{const player=read('components/MindscapePanel.tsx');assert.match(player,/formatTrackDate/);assert.match(player,/Loading your private playlist/);assert.match(player,/No Mindscapes yet/);assert.match(player,/Playlist unavailable/);assert.doesNotMatch(player,/>\{track\.date\}</)});
test('playlist and source post expose private provenance without nested interactive controls or provider fields',()=>{const player=read('components/MindscapePanel.tsx');const post=read('pages/JournalPostPage.tsx');assert.match(player,/role="list"/);assert.match(player,/role="listitem"/);assert.match(player,/aria-current/);assert.match(player,/<\/button><Link to=/);assert.doesNotMatch(player,/<button[^>]*>[\s\S]*?<Link[^>]*>[\s\S]*?<\/Link><\/button>/);assert.match(player,/Open source journal entry/);assert.match(post,/Daily Mindscape — inspired by this entry/);assert.doesNotMatch(player,/provider_url|media_path|song_path/)});

test('explicit requested track wins when an older authenticated audio request resolves last',async()=>{
 const { createMindscapeAudioLoader }=await import('../src/components/mindscapeAudioLoader.mjs');
 const pending=new Map();
 const fetchAudio=runKey=>new Promise(resolve=>pending.set(runKey,resolve));
 const created=[],revoked=[];
 const loader=createMindscapeAudioLoader({fetchAudio,createObjectURL:blob=>{const url=`blob:${blob.runKey}`;created.push(url);return url},revokeObjectURL:url=>revoked.push(url)});
 const older=loader.load({run_key:'older'}),newer=loader.load({run_key:'newer'});
 pending.get('newer')({ok:true,blob:async()=>({runKey:'newer'})});
 assert.equal(await newer,'blob:newer');
 pending.get('older')({ok:true,blob:async()=>({runKey:'older'})});
 assert.equal(await older,null);
 assert.deepEqual(created,['blob:newer']);
 assert.deepEqual(revoked,[]);
});

test('audio loader reports errors without leaking private response details',async()=>{
 const { createMindscapeAudioLoader }=await import('../src/components/mindscapeAudioLoader.mjs');
 const loader=createMindscapeAudioLoader({fetchAudio:async()=>({ok:false,statusText:'/private/storage/song.mp3'}),createObjectURL:()=>assert.fail('must not create URL'),revokeObjectURL:()=>{}});
 await assert.rejects(loader.load({run_key:'secret-run'}),error=>error.message==='Private audio could not be loaded');
});

test('cancellation after authenticated response but before blob completion revokes the late object URL',async()=>{
 const { createMindscapeAudioLoader }=await import('../src/components/mindscapeAudioLoader.mjs');
 let resolveBlob;
 const blobPending=new Promise(resolve=>{resolveBlob=resolve});
 const revoked=[];
 const loader=createMindscapeAudioLoader({fetchAudio:async()=>({ok:true,blob:()=>blobPending}),createObjectURL:blob=>`blob:${blob.runKey}`,revokeObjectURL:url=>revoked.push(url)});
 const loading=loader.load({run_key:'leaving-page'});
 await Promise.resolve();
 loader.cancel();
 resolveBlob({runKey:'leaving-page'});
 assert.equal(await loading,null);
 assert.deepEqual(revoked,['blob:leaving-page']);
});

test('player traps keyboard focus, restores prior focus, and keeps errors privacy-safe',()=>{const player=read('components/MindscapePanel.tsx');assert.match(player,/e\.key==='Tab'/);assert.match(player,/previousFocus\.current\?\.focus/);assert.match(player,/role="alert"/);assert.match(player,/No private media details were exposed/);assert.doesNotMatch(player,/statusText|response\.url/)});

test('source-post private audio uses the shared race-safe loader and cancels on route or track cleanup',()=>{
 const post=read('pages/JournalPostPage.tsx');
 assert.match(post,/createMindscapeAudioLoader/);
 assert.match(post,/privateSongLoader\.current\.cancel\(\)/);
 assert.match(post,/\[id, entry\?\.journal_publication_key\]/);
 assert.match(post,/privateSongSource\.current/);
 assert.match(post,/URL\.revokeObjectURL\(privateSongSource\.current\)/);
});
