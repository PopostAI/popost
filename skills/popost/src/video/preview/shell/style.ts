/**
 * The shell's style, inlined into its HTML by the server. Colours come only from the variables in :root; the stage
 * is dark in both themes because pictures are judged against black. The rules after "Edit mode" style edit/.
 */
export const SHELL_CSS = `
:root{color-scheme:light dark;--bg:#f5f5f3;--surface:#fff;--fg:#1d1f23;--muted:#62656d;--line:#d8d8d3;--accent:#2457c5;--on-accent:#fff;
--seg:#e4e9f3;--item:#e3eee4;--audio:#eee6f4;--shade:rgba(29,31,35,.18);--render:#b45309;--reference:#0f766e;--err:#b42318;--warn:#8a5a00;
--head:#d92d20;--stage:#26272b;--stage-fg:#d6d6d2;--frame:#000}
@media (prefers-color-scheme:dark){:root{--bg:#141518;--surface:#1c1d21;--fg:#e4e4e1;--muted:#9a9ca4;--line:#34363c;--accent:#7aa2f7;--on-accent:#0b0d12;
--seg:#263043;--item:#233528;--audio:#33283d;--shade:rgba(255,255,255,.2);--render:#f59e0b;--reference:#2dd4bf;--err:#f97066;--warn:#e9b44c;
--head:#f87171;--stage:#0d0e10;--stage-fg:#c9c9c4;--frame:#000}}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font:13px/1.4 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg);overflow:hidden}
#app{display:grid;grid-template-rows:auto minmax(0,1fr);height:100vh;height:100dvh}
header{display:flex;align-items:center;gap:14px;padding:6px 12px;border-bottom:1px solid var(--line);background:var(--surface);min-width:0;white-space:nowrap}
header h1{font-size:14px;margin:0;font-weight:600}
header .project{color:var(--muted);overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 auto}
header .status{color:var(--muted)}
header .status.offline{color:var(--err)}
.toggle{display:inline-flex;align-items:center;gap:4px;cursor:pointer;user-select:none}
.toggle input{accent-color:var(--accent);margin:0}
.main{display:grid;grid-template-columns:minmax(0,1fr) 360px;min-height:0}
.left{display:flex;flex-direction:column;min-width:0;min-height:0}
.stage-area{flex:1 1 0;min-height:180px;display:flex;align-items:center;justify-content:center;gap:16px;padding:8px 12px;background:var(--stage);overflow:hidden}
.viewer{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0;max-width:100%}
.caption,.note{color:var(--stage-fg);font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.note{font-size:11px;opacity:.8;min-height:15px}
.note.error{color:var(--err);opacity:1}
.frame-box{position:relative;overflow:hidden;background:var(--frame);flex:0 0 auto}
.scaler{transform-origin:0 0}
.scaler iframe{display:block;width:100%;height:100%;border:0;pointer-events:none;background:var(--frame)}
.frame-box.problems iframe{pointer-events:auto}
#reference-video{display:block;width:100%;height:100%;object-fit:contain;background:var(--frame)}
.overlay{position:absolute;inset:0;pointer-events:none}
.overlay>div{position:absolute}
.ibox{border:1px dashed var(--accent);pointer-events:auto;cursor:pointer}
.ebox{border:1px solid var(--render)}
.safe{border:1px dashed var(--reference)}
.ibox span,.ebox span{position:absolute;left:0;top:0;font-size:10px;line-height:1.3;padding:0 3px;color:var(--on-accent);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.ibox span{background:var(--accent)}
.ebox span{background:var(--render)}
#reference-view .ebox{border-color:var(--reference)}
#reference-view .ebox span{background:var(--reference)}
.transport{display:flex;align-items:center;gap:6px;padding:6px 12px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--surface);flex:0 0 auto;min-width:0;white-space:nowrap}
.tbtn{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:26px;padding:0 6px;border:1px solid var(--line);border-radius:4px;background:var(--surface);color:var(--fg);font:inherit;cursor:pointer;flex:0 0 auto}
.tbtn:hover{border-color:var(--muted)}
.tbtn:focus-visible,.chip:focus-visible,.link:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.icon{display:inline-flex}
.slider-wrap{flex:1 1 120px;min-width:80px;display:flex}
#slider{width:100%;accent-color:var(--accent);margin:0}
.readout{display:inline-flex;gap:10px;font-variant-numeric:tabular-nums}
.num{font-variant-numeric:tabular-nums}
#jump{width:110px}
#frame-no{display:inline-block;min-width:3ch;text-align:right;font-weight:600}
.muted{color:var(--muted)}
select,input[type=text]{font:inherit;color:var(--fg);background:var(--surface);border:1px solid var(--line);border-radius:4px;height:26px;padding:0 4px}
input[aria-invalid=true]{border-color:var(--err)}
.timeline{flex:0 1 auto;max-height:42%;min-height:60px;overflow:auto;background:var(--surface)}
.lanes{position:relative;--label:150px}
.lane{display:grid;grid-template-columns:var(--label) minmax(0,1fr);height:24px;border-bottom:1px solid var(--line)}
.lane-label{padding:0 8px;font-size:12px;line-height:23px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-right:1px solid var(--line);color:var(--muted)}
.lane-label[data-sel]{cursor:pointer;color:var(--fg)}
.lane-track{position:relative;overflow:hidden;cursor:pointer}
.lane-track>*{position:absolute}
.blk,.shade,.ev{top:3px;bottom:3px;border-radius:3px;font-size:11px;line-height:16px;padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:2px}
.blk.seg{background:var(--seg);top:2px;bottom:auto;height:18px}
.blk.item{background:var(--item)}
.blk.audio{background:var(--audio)}
.blk.word{padding:0 1px;text-overflow:clip}
.blk.word.unsure{opacity:.5}
.shade{background:repeating-linear-gradient(135deg,var(--shade) 0 4px,transparent 4px 8px);border:1px solid var(--shade)}
.lane.segments{height:42px}
.swatch{display:inline-block;width:9px;height:9px;margin-right:4px;border:1px solid var(--line);vertical-align:-1px}
.band{top:0;bottom:0;background:color-mix(in srgb,var(--accent) 18%,transparent);border-left:1px solid var(--accent);border-right:1px solid var(--accent)}
.band-label{position:absolute;left:3px;bottom:1px;font-size:10px;line-height:14px;white-space:nowrap;color:var(--accent)}
.tick{top:0;bottom:0;width:1px;background:var(--muted)}
.lane.ruler{height:20px}
.rtick{top:0;bottom:0;border-left:1px solid var(--line);padding-left:3px;font-size:10px;line-height:19px;color:var(--muted);white-space:nowrap}
.mark{top:0;bottom:0;width:2px;margin-left:-1px;background:var(--render)}
.mark-label{position:absolute;left:4px;top:4px;font-size:10px;line-height:14px;white-space:nowrap;color:var(--render)}
.mband{top:0;bottom:0;background:color-mix(in srgb,var(--render) 22%,transparent)}
.ev{height:11px;bottom:auto;line-height:11px;font-size:9px;padding:0 2px;background:color-mix(in srgb,var(--render) 32%,transparent)}
.reference .mark{background:var(--reference)}
.reference .mark-label{color:var(--reference)}
.reference .mband{background:color-mix(in srgb,var(--reference) 22%,transparent)}
.reference .ev{background:color-mix(in srgb,var(--reference) 32%,transparent)}
.selected{outline:2px solid var(--accent);outline-offset:-2px}
.playhead-layer{position:absolute;top:0;bottom:0;left:var(--label);right:0;pointer-events:none;overflow:hidden}
.playhead{position:absolute;top:0;bottom:0;min-width:2px;background:color-mix(in srgb,var(--head) 30%,transparent);border-left:1px solid var(--head)}
.panel{border-left:1px solid var(--line);overflow:auto;min-width:0;padding:4px 12px 16px;background:var(--surface)}
.panel h2{font-size:12px;margin:12px 0 6px;color:var(--muted);display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;font-weight:600}
.json{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:6px 8px;margin:0;max-height:300px;overflow:auto;white-space:pre}
.sel-title{font-weight:600;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;align-items:center}
.chip{font:inherit;font-size:11px;border:1px solid var(--line);border-radius:10px;padding:1px 8px;background:var(--surface);color:var(--fg);cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.link{font:inherit;font-size:11px;border:0;background:none;color:var(--accent);cursor:pointer;padding:0}
.panel ul{list-style:none;margin:0;padding:0}
.problem,.note-item{border:1px solid var(--line);border-radius:4px;padding:6px 8px;margin-bottom:6px;overflow-wrap:anywhere}
b.error{color:var(--err)}
b.warning{color:var(--warn)}
code{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
table.score{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}
table.score th,table.score td{text-align:left;padding:3px 4px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
table.score th:nth-child(1){width:30%}
table.score th:nth-child(2){width:16%}
table.score th:nth-child(3){width:18%}
table.score tr.total td{font-weight:600}
.detail{color:var(--muted);font-size:11px}
.kv{display:flex;gap:4px;min-width:0}
.kv>span{flex:0 0 auto}
.kv code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.message{color:var(--warn);margin:4px 0;overflow-wrap:anywhere}
header{overflow:hidden}
.edit-slot:empty{display:none}
.edit-tools{display:inline-flex;gap:10px}
.tool-group{display:inline-flex;gap:4px}
.tbtn:disabled{opacity:.45;cursor:default}
.tbtn:disabled:hover{border-color:var(--line)}
.edit-status{position:sticky;top:-4px;z-index:2;margin:-4px -12px 0;padding:4px 12px;background:var(--surface);border-bottom:1px solid var(--line)}
.status-line{font-size:12px;overflow-wrap:anywhere;max-height:4.3em;overflow:auto;margin:2px 0}
.status-line:empty{display:none}
.bad{color:var(--err)}
.form .sel-title{margin:2px 0 6px}
fieldset.fs{border:1px solid var(--line);border-radius:4px;margin:0 0 8px;padding:2px 8px 6px;min-width:0}
fieldset.fs legend{font-size:11px;color:var(--muted);padding:0 4px}
.row{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0}
.fld{display:flex;flex-direction:column;gap:2px;flex:1 1 64px;min-width:0}
.fld.wide{flex:2 1 140px}
.fld.area{flex:1 1 100%}
.fl{font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fld input,.fld select,.fld textarea{width:100%;min-width:0}
input[type=number],textarea{font:inherit;color:var(--fg);background:var(--surface);border:1px solid var(--line);border-radius:4px}
input[type=number]{height:26px;padding:0 4px}
textarea{padding:3px 4px;resize:vertical;line-height:1.35}
[aria-invalid=true]{border-color:var(--err)}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:-1px}
.rv{font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fprob{font-size:11px;color:var(--err);overflow-wrap:anywhere}
.hint{font-size:11px;color:var(--muted);margin-top:2px}
.colour{display:flex;gap:4px;align-items:center;min-width:0}
.colour input[type=text]{flex:1 1 auto}
.swatch-pick{width:26px;height:26px;padding:0;border:1px solid var(--line);border-radius:4px;background:var(--surface);flex:0 0 26px}
.cues h3{font-size:12px;margin:8px 0 4px;color:var(--muted);font-weight:600}
fieldset.cue{padding-bottom:4px}
fieldset.cue fieldset.fs{border:0;padding:0;margin:0}
fieldset.cue.current{border-color:var(--accent)}
.edit-layer{position:absolute;inset:0;z-index:1}
.edit-layer.off{pointer-events:none}
.edit-layer>div{position:absolute}
.sel-box{border:1px solid var(--accent);cursor:move}
.handle{position:absolute;width:9px;height:9px;margin:-5px 0 0 -5px;background:var(--surface);border:1px solid var(--accent)}
.h-nw{left:0;top:0;cursor:nwse-resize}.h-n{left:50%;top:0;cursor:ns-resize}.h-ne{left:100%;top:0;cursor:nesw-resize}.h-e{left:100%;top:50%;cursor:ew-resize}
.h-se{left:100%;top:100%;cursor:nwse-resize}.h-s{left:50%;top:100%;cursor:ns-resize}.h-sw{left:0;top:100%;cursor:nesw-resize}.h-w{left:0;top:50%;cursor:ew-resize}
.drag-readout{left:4px;bottom:4px;max-width:calc(100% - 8px);font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface);color:var(--fg);padding:1px 4px;border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.editing .blk.item,.editing .shade{cursor:grab}
.grip{top:3px;bottom:3px;width:7px;margin-left:-3px;cursor:ew-resize;z-index:1;border-radius:2px}
.seg-grip{top:0;bottom:0;width:7px;margin-left:-4px;cursor:col-resize;z-index:2}
.grip:hover,.seg-grip:hover{background:color-mix(in srgb,var(--accent) 40%,transparent)}
.grip.selected{outline:none}
.drag-ghost{top:3px;bottom:3px;border:1px dashed var(--accent);background:color-mix(in srgb,var(--accent) 15%,transparent);border-radius:3px;pointer-events:none;z-index:3}
.snap-guide{position:absolute;top:0;bottom:0;width:0;border-left:1px dashed var(--muted)}
.snap-guide.snapped{border-left:2px solid var(--accent)}
.lane-readout{position:absolute;top:2px;margin-left:6px;font-size:11px;line-height:16px;background:var(--surface);border:1px solid var(--line);border-radius:3px;padding:0 4px;white-space:nowrap;color:var(--fg)}
`;
