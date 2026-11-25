import type { Runtime } from '../../runtime';
export type DraftTarget = 'jianying' | 'capcut';
export interface DraftMedia { id: string; file: string; start: number; duration: number; width?: number; height?: number; gain?: number }
export interface DraftCaption { text: string; start: number; duration: number }
const timerange = (duration: number, start = 0) => ({ duration, start });
const clip = () => ({ alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } });
const segment = (rt: Runtime, m: DraftMedia, index: number) => ({
  id: rt.randomUUID(), material_id: m.id, source_timerange: timerange(m.duration) as ReturnType<typeof timerange> | null, target_timerange: timerange(m.duration, m.start),
  render_timerange: timerange(0), speed: 1, volume: m.gain ?? 1, last_nonzero_volume: m.gain ?? 1, visible: true, reverse: false, track_attribute: 0, source: 'segmentsourcenormal', state: 0, uniform_scale: {on:true,value:1},
  track_render_index: index, render_index: index, clip: clip(), extra_material_refs: [], common_keyframes: [], keyframe_refs: [],
  enable_adjust: true, enable_color_curves: true, enable_color_match_adjust: false, enable_color_wheels: true, enable_lut: true, enable_smart_color_adjust: false,
});
const material = (m: DraftMedia, type: string) => ({ id: m.id, name: m.file.split('/').pop(), material_name:m.file.split('/').pop(), material_id:m.id, path: m.file, type, duration: m.duration, local_material_id: m.id, category_name:'local', check_flag:type==='video'?63487:3,
  ...(type === 'video' ? { width: m.width, height: m.height, has_audio: false, crop: { upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0, lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 }, crop_ratio: 'free', crop_scale: 1, audio_fade: null } : { music_id: '', resource_id: '', source_platform: 0, wave_points: [] }) });

/** Public draft interchange fields, independently authored; all durations are integer microseconds. */
export const draftContent = (rt: Runtime, o: { id: string; name: string; target: DraftTarget; width: number; height: number; fps: number; duration: number; videos: DraftMedia[]; audio: DraftMedia[]; captions: DraftCaption[] }) => {
  const texts = o.captions.map(c => ({ id: rt.randomUUID(), type: 'text', name: c.text.slice(0,40), content: JSON.stringify({ text: c.text, styles: [{ range: [0,[...c.text].length], fill: { alpha:1, content: { render_type: 'solid', solid: { alpha: 1, color: [1,1,1] } } }, size: 8 }] }),
    alignment: 1, typesetting:0, line_feed:1, line_max_width:.82, force_apply_line_max_width:true, check_flag:7, global_alpha:1, layer_weight:1, initial_scale:1, inner_padding:-1, fixed_width:-1, fixed_height:-1, font_title:'none', text_size:30, font_size: 8, text_color: '#FFFFFF', text_alpha: 1, font_path: '', font_name: '', bold_width: 0, border_width: .08, border_color: '#000000', line_spacing: .02, letter_spacing: 0, is_rich_text: true }));
  const track = (type: string, segments: ReturnType<typeof segment>[]) => ({ id: rt.randomUUID(), type, attribute: 0, flag: 0, name: '', is_default_name: true, segments });
  return { id: o.id, name: o.name, version: 360000, new_version: '110.0.0', fps: o.fps, duration: o.duration, create_time: 0, update_time: 0,
    path:'',source:'default',canvas_config: { width: o.width, height: o.height, ratio: 'original' }, color_space: 0, cover: null, keyframe_graph_list: [], keyframes: {adjusts:[],audios:[],effects:[],filters:[],handwrites:[],stickers:[],texts:[],videos:[]}, relationships: [],
    config: { video_mute: false, maintrack_adsorb: true, material_save_mode: 0, combination_max_index: 1, extract_audio_last_index: 1, lyrics_sync: true, original_sound_last_index: 1, record_audio_last_index: 1, subtitle_sync: true, subtitle_taskinfo: [], subtitle_keywords_config: null },
    platform: { app_id: o.target === 'jianying' ? 3704 : 359289, app_source: o.target === 'jianying' ? 'lv' : 'cc', app_version: '5.9.0', os: 'mac', os_version: '' },
    last_modified_platform: { app_id: o.target === 'jianying' ? 3704 : 359289, app_source: o.target === 'jianying' ? 'lv' : 'cc', app_version: '5.9.0', os: 'mac', os_version: '' },
    materials: { videos: o.videos.map(m => material(m,'video')), audios: o.audio.map(m => material(m,'extract_music')), texts,
      beats: [], canvases: [], chromas: [], color_curves: [], digital_humans: [], drafts: [], effects: [], flowers: [], green_screens: [], handwrites: [], hsl: [], images: [], log_color_wheels: [], loudnesses: [], manual_deformations: [], masks: [], material_animations: [], material_colors: [], placeholders: [], plugin_effects: [], primary_color_wheels: [], realtime_denoises: [], shapes: [], smart_crops: [], sound_channel_mappings: [], speeds: [], stickers: [], tail_leaders: [], text_templates: [], transitions: [], video_effects: [], vocal_beautifys: [], vocal_separations: [] },
    tracks: [track('video',o.videos.map(m=>segment(rt,m,0))), ...o.audio.map((m,i)=>track('audio',[segment(rt,m,i+1)])), ...(texts.length ? [track('text',texts.map((m,i)=>{
      const c = o.captions[i]!; const s = segment(rt,{ id:m.id,file:'',start:c.start,duration:c.duration },o.audio.length+1); s.source_timerange=null; s.clip.transform.y = -.8; return s;
    }))] : [])],
  };
};
