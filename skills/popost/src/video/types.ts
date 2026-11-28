/**
 * Shared contract of the video engine. Everything is in integer frames; positions are fractions of the canvas.
 * Three groups: the project (video.json), the resolved timeline (what the page runtime plays), and the measurement
 * (what a program reads from any video file, a reference or our own render).
 *
 * Frame conventions (used by the timeline, the runtime, the measurement and the scorer alike):
 * - Segment k starts at frame S_k = the sum of the lengths of the segments before it. The video's length is the sum of
 *   all segment lengths; transitions never change it.
 * - A transition of F frames into segment k mixes the pictures on exactly the F frames a .. a+F-1, where
 *   a = S_k - floor(F / 2). On frame n of that span the progress is p = (n - a + 1) / (F + 1), so no frame of the span is
 *   purely the old or purely the new picture. As a measured boundary this is { start: a - 1, end: a + F, frame: S_k }:
 *   start = the last frame that is purely the old shot, end = the first frame that is purely the new shot.
 *   A hard cut is { start: S_k - 1, end: S_k, frame: S_k }.
 * - A one-sided transition (TransitionSpec.side) mixes no pictures: one shot alone is shown under the effect, whose
 *   amount runs from 0 (none) to 1 (full, times "strength"). 'after': a hard cut at S_k, then the new shot settles out
 *   of the effect on the F frames a .. a+F-1 with a = S_k; with q = (n - a) / F the amount on frame n is 1 - ease(q),
 *   full on frame S_k and gone on frame a + F. 'before': the old shot goes into the effect on the F frames a .. a+F-1
 *   with a = S_k - F; with q = (n - a + 1) / F the amount is ease(q), full on frame S_k - 1; then a hard cut, and frame
 *   S_k is purely new. A perfect measurement reports both with the same rule { start: a - 1, end: a + F, frame: S_k },
 *   where "purely" also means "with no effect": 'after' is { S_k - 1, S_k + F, S_k } and 'before' { S_k - F - 1, S_k,
 *   S_k }. The side is read from where frame lies: frame = start + 1 is 'after', frame = end is 'before' (a hard cut is
 *   both at once).
 * - A track item is on screen on frames start .. end-1. Its entrance plays on its first enter.frames frames, its exit
 *   on its last exit.frames frames. A loop counts j = n - (start + enter.frames) from the first frame after the
 *   entrance (j = 0 before it); during the exit j holds the value of the exit's first frame.
 *
 * Words (phrase anchors and captions that follow the spoken word). An audio material may name a words file (WordsFile):
 * the tokens of its script exactly as src/align writes them, one per unit (a CJK character, a run of Latin letters or
 * digits), each spoken on frames start .. end-1 counted from the start of the audio file at the file's own fps. An
 * audio track that plays the material puts token t on the timeline at
 *     A + round(t.start * fps / wordsFps) .. A + round(t.end * fps / wordsFps) - 1
 * where A is the track's start frame and fps the canvas' (timeline/words.ts; tokens stay in order and keep at least
 * one frame). A phrase span { phrase, occurrence, of, lead, hold } finds the phrase's units among those tokens (case
 * and punctuation do not matter) and puts the item on frames (first.start - lead) .. (last.end - 1 + hold): from the
 * first frame of its first token minus lead to the last frame of its last token plus hold. So when the wording, the
 * voice or the language changes, everything anchored to a phrase moves with its words, and frame spans stay.
 *
 * Video footage (a segment base or a video item of a video material) is shown frame by frame as pictures. With i = n - S
 * (the project frames since the segment or the item started, S = its start), the source frame shown at project frame n
 * is
 *     source = in + round(i * sourceFps * speed / canvas.fps)
 * counted in the source video's own frames (0-based, decode order), clamped to the source's last frame, which then holds.
 * A segment's base follows this rule on every frame it is visible, the transitions around it included; before its start
 * (i < 0) it shows frame "in". round is JavaScript's Math.round, computed in exactly this order (timeline/footage.ts), so
 * Node and the page agree on every frame.
 */

/** [x, y, width, height] as fractions of the canvas, origin top left. */
export type Box = [number, number, number, number];
export type Ease = 'linear' | 'in' | 'out' | 'in-out';
export type Direction = 'left' | 'right' | 'up' | 'down';
export type WipeDirection = Direction | 'center-out' | 'edges-in';

export const TRANSITION_KINDS = ['cut', 'fade', 'flash', 'dissolve', 'wipe', 'slide', 'zoom', 'spin', 'blur', 'glitch', 'shake', 'whip'] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

export const MOTION_PRESETS = ['none', 'fade', 'pop', 'scale-in', 'slide', 'wipe', 'type', 'blur'] as const;
export type MotionPreset = (typeof MOTION_PRESETS)[number];

export const LOOP_PRESETS = ['pulse', 'float', 'sway', 'blink', 'spin'] as const;
export type LoopPreset = (typeof LOOP_PRESETS)[number];

// ---------------------------------------------------------------------------------------------------------------------
// Project (video.json)

export interface Canvas { width: number; height: number; fps: number }

export interface Material {
  id: string;
  /**
   * The engine renders 'image' and 'video', mixes 'audio' and declares 'font' (a .woff2, .woff, .ttf or .otf file; a
   * text style names it by the material's id in "font"). The other kinds are produced by server tasks (later phases).
   */
  kind: 'image' | 'video' | 'audio' | 'font' | 'voice' | 'speech';
  /** Path relative to the project directory. */
  file?: string;
  prompt?: string;
  note?: string;
  /**
   * Audio only: a words file (WordsFile, JSON, relative to the project directory) with what is said in the file and
   * when. An audio track that plays this material makes its words addressable by phrase anchors and caption tracks.
   */
  words?: string;
}

/** One token of a words file, as src/align writes it (AlignedToken). Frames from the start of the audio file. */
export interface WordToken {
  /** One unit: a CJK character, or a run of Latin letters or digits (punctuation around it is ignored). */
  text: string;
  /** Spoken on start .. end-1. Whole frames at the file's fps (fractions are rounded). */
  start: number;
  end: number;
  /** 0..1. 1: heard as written; about 0.5: something else was heard in its place; about 0.2: interpolated. Default 1. */
  confidence: number;
  /** Heard as written. Default true. */
  matched: boolean;
}

/** The words of an audio material: { "fps": 30, "tokens": [...] }, tokens in order and not overlapping. */
export interface WordsFile { fps: number; tokens: WordToken[] }

/** What the build step read from a words file: the file, or why it cannot be used (with one fix). */
export type WordsInfo = WordsFile | { error: string; fix: string };

export interface TransitionSpec {
  transition: TransitionKind;
  /** Length of the mixed span. Ignored for 'cut'. */
  frames?: number;
  /** wipe: any WipeDirection, the way the edge travels ('left': the new picture is revealed from the right).
   *  slide / whip: a Direction, the way the pictures travel. */
  direction?: WipeDirection;
  /** slide only. push: both pictures move; cover: the new one slides over; reveal: the old one slides away. */
  mode?: 'push' | 'cover' | 'reveal';
  /** fade only: the flat colour the fade passes through. */
  via?: 'black' | 'white';
  /** Default 'in-out' or 'linear' by kind; a one-sided transition defaults to 'out' ('after') or 'in' ('before'). */
  ease?: Ease;
  /**
   * 'both' (default): the span straddles the boundary. 'after': a hard cut, then the new shot settles out of the effect.
   * 'before': the old shot goes into the effect, then a hard cut. One-sided: blur, zoom, shake, flash, whip, glitch,
   * fade and spin only. Frames: the header.
   */
  side?: 'both' | 'after' | 'before';
  /** 0..2, default 1: scales the effect's amount (blur radius, zoom, shake and glitch offset, whip smear, veil, angle). */
  strength?: number;
}

/** Constant rates over the base's whole visible range. */
export interface CameraRate {
  /** Change of scale per second: 0.04 pushes in by 4% of the frame per second, a negative value pulls out. */
  zoom?: number;
  /** Travel of the picture per second, as fractions of the canvas: [x, y]. */
  pan?: [number, number];
}

/**
 * One keyframed move: on frames from .. to (counted from the segment's start) the picture goes from scale[0] to
 * scale[1] around the focus point, eased, and optionally shifts from shift[0] to shift[1]. Before the first move the
 * camera holds the first move's start; between moves and after the last it holds the last state reached.
 */
export interface CameraMove {
  from: number;
  to: number;
  /** At least 1 (below 1 an edge would show). */
  scale: [number, number];
  /** The point of the picture that stays in place on screen while it scales, fractions of the frame. Default [0.5, 0.5]. */
  focus?: [number, number];
  /** Offset of the picture at from and at to, fractions of the canvas. Default none. */
  shift?: [[number, number], [number, number]];
  /** Default 'linear'. */
  ease?: Ease;
}

export type CameraSpec = CameraRate | { moves: CameraMove[] };

/** A linear or radial gradient. */
export interface Gradient {
  type: 'linear' | 'radial';
  /** linear: degrees as in CSS (0 runs from the bottom up, 90 from left to right). Default 180 (top to bottom). */
  angle?: number;
  /** At least two, at 0..1 along the gradient (radial: from the centre to the farthest corner), in order. */
  stops: { at: number; color: string }[];
}

/** A flat colour or a gradient. */
export type Fill = string | Gradient;

/** A soft shadow. Units are given where it is used. */
export interface Shadow { color: string; blur?: number; x?: number; y?: number }

/**
 * What a clip's own sound is in the video (references/video-sound.md, rule R3). speech: the person on screen is the
 * video's speaker: heard at full level, and no voice-over lies over it. exhibit: the clip is the thing being shown:
 * its whole sound (speech and music included) is heard, lowered under the voice-over and back in its pauses, and the
 * video's music gives way for the span. ambience: the sound of the place, lowered under every voice. silent: never heard.
 */
export const SOUND_MODES = ['speech', 'exhibit', 'ambience', 'silent'] as const;
export type SoundMode = (typeof SOUND_MODES)[number];

/** How a video material plays where it is used (a segment base or a video item). The frame mapping is in the header. */
export interface FootageSpec {
  /**
   * The role of the footage's sound here (SoundMode). Left out: the mode the clip was made with (its receipt,
   * <file>.mode.json), else the automatic rule of "audio" below. A mode says the sound is wanted: an exhibit or an
   * ambience is heard in a project with audio tracks too.
   */
  soundMode?: SoundMode;
  /** The first frame shown, counted in the source video's own frames. Default 0. */
  in?: number;
  /** Playback rate, 0.25 to 4. Default 1. */
  speed?: number;
  /**
   * The footage's own sound. false: silent. A number: mixed at this gain in dB. Left out: automatic, which is 0 dB
   * in a project with no audio track and silent in one that has an audio track (a voice-over, music): a clip that
   * came with sound keeps it unless the video brings a sound of its own. It plays at the footage's speed, pitch kept.
   */
  audio?: false | number;
}

/**
 * A picture or video material, a flat colour, or a scene. in / speed / audio apply to a video material only.
 * ground: what shows around a material that does not fill the canvas (fit 'contain': a 16:9 picture on a 9:16
 * canvas). Default: black.
 */
export type Base =
  | ({ material: string; fit?: 'cover' | 'contain'; ground?: Fill; camera?: CameraSpec } & FootageSpec)
  | { color: Fill }
  /**
   * A scene: the path of an HTML file in the project (scenes/hook.html), written for this video. It fills the
   * canvas and its motion is CSS animations and Web Animations, which the engine sets to the frame's time (seconds
   * from the segment's start); it may also set window.__popostScene = { render(seconds, fps) } for what animations
   * cannot say. The rules a scene keeps are in references/video-scenes.md.
   * slots: new content for the places the scene marks with data-slot="name": the text of an element, or the
   * picture of an <img> (a path in the project). A scene written once is used again with other words this way.
   */
  | { scene: string; slots?: Record<string, string>; offset?: number };

export interface Segment {
  id: string;
  /** Length in frames. Required for a segment without speech (the only kind in v1 of the engine). */
  frames?: number;
  base: Base;
  /** The transition from the segment before this one. Absent = a hard cut. Not allowed on the first segment. */
  in?: TransitionSpec;
  note?: string;
}

export interface MotionSpec {
  preset: MotionPreset;
  frames?: number;
  ease?: Ease;
  /** pop only: how far past its final size the element goes, as a fraction (0.12 = 12% larger at the peak). */
  overshoot?: number;
  /** slide: the way the element travels while entering (or leaving). wipe: the way the reveal edge travels. */
  direction?: Direction;
  /** slide only: travel as a fraction of the canvas' smaller side. Default 0.25. */
  distance?: number;
}

/**
 * Where on the timeline an item sits: frames counted from the start of a segment (segment, from, to), or the words of
 * a sound (phrase, occurrence, of, lead, hold; header). One of segment and phrase is required; a phrase span takes no
 * from / to.
 */
export interface Span {
  segment?: string;
  /** First frame, counted from the segment's start. Default 0; a negative value is clamped to 0. */
  from?: number;
  /** End (exclusive), counted from the segment's start. Default: the end of the segment. May run past it. */
  to?: number;
  /** Words of the script of an audio track with words, matched unit by unit (src/align tokenize). */
  phrase?: string;
  /** Which time the phrase is spoken, from 1. Required when it is spoken more than once. */
  occurrence?: number;
  /** Id of the audio track whose words hold the phrase. May be left out when exactly one audio track has words. */
  of?: string;
  /** Frames on screen before the phrase's first token (default 0) and after its last (default 0). Negative shortens. */
  lead?: number;
  hold?: number;
}

/** Part of a text set differently: characters from .. to-1, counted by code point (a CJK character or an emoji is one). */
export interface TextSpanStyle {
  from: number;
  to: number;
  color?: string;
  weight?: number;
  /** As TextStyle.background, behind these characters only. */
  background?: { color: string; padding?: number; radius?: number };
  italic?: boolean;
}

export interface TextStyle {
  /** CSS font-family list; the id of a font material names that font. */
  font?: string;
  /** Font size as a fraction of the canvas height. */
  size?: number;
  weight?: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  /** width is a fraction of the font size. The stroke is painted under the fill, so half of it shows outside the glyph. */
  stroke?: { color: string; width: number };
  /** A box behind the text. padding and radius are fractions of the font size. */
  background?: { color: string; padding?: number; radius?: number };
  italic?: boolean;
  /** Under the glyphs; blur, x and y are fractions of the font size. Default blur 0.12, x 0.04, y 0.06. */
  shadow?: Shadow;
  /** Extra space after every character, a fraction of the font size (may be negative). Default 0. */
  letterSpacing?: number;
  /** Distance between lines as a multiple of the font size. Default 1.25. */
  lineHeight?: number;
  /** 0..1, the whole text. Default 1. */
  opacity?: number;
  /** Characters set differently; they must not overlap. */
  spans?: TextSpanStyle[];
  /** A caption track that follows the words (CaptionTrack.words) only: how the token being spoken looks. */
  spoken?: SpokenStyle;
}

/**
 * How a token of a caption that follows the words looks while it is spoken, and after. Before its time a token has
 * the base style; on its frames this style; afterwards "past", or the base style when there is no "past". Nothing in
 * it moves the layout: every token's room is set at the heavier of its own weight and "weight", and "background" and
 * "scale" are drawn without taking room.
 */
export interface SpokenStyle {
  color?: string;
  /** A box behind the token while it is spoken. padding (default 0.1) and radius (default 0.2): fractions of the font size. */
  background?: { color: string; padding?: number; radius?: number };
  weight?: number;
  /** 1 to 1.3: the token is drawn this much larger around its centre while it is spoken. Default 1. */
  scale?: number;
  past?: { color?: string; opacity?: number };
}

export interface LoopSpec {
  /**
   * pulse: the scale breathes up by amount (default 0.06) and back. float: up and down by amount, a fraction of the
   * canvas' smaller side (default 0.015). sway: rotates to +-amount degrees (default 6). blink: shown for the first
   * half of each period, at opacity 1 - amount for the second (default 1). spin: amount turns per period (default 1).
   */
  preset: LoopPreset;
  /** Frames per cycle, at least 2. */
  period: number;
  amount?: number;
}

/** What every visual item may also carry. */
export interface ItemLook {
  /** Degrees, clockwise, around the box's centre. Default 0. */
  rotate?: number;
  /** 0..1, multiplies the entrance and exit. Default 1. */
  opacity?: number;
  /** Drawn inside the box; width is a fraction of the canvas' smaller side. */
  border?: { color: string; width: number };
  /** Follows what the item draws (glyphs, shape, a picture's transparency); blur, x and y are fractions of the canvas'
   *  smaller side. Default blur 0.02, x 0.006, y 0.01. */
  shadow?: Shadow;
  /** Runs between the entrance and the exit (frames: the header). */
  loop?: LoopSpec;
}

interface ItemCommon extends ItemLook {
  id: string;
  during: Span;
  box: Box;
  enter?: MotionSpec;
  exit?: MotionSpec;
  /** Id of an audio material played when the item enters. */
  sound?: string;
  /** Stacking order among items; larger is nearer. Default: the order in the file. */
  z?: number;
  note?: string;
}

export interface TextTrack extends ItemCommon { type: 'text'; text: string; style?: string | TextStyle }
/** radius: corner radius as a fraction of the box's smaller side; mask 'ellipse' shows the ellipse inside the box. */
export interface ImageTrack extends ItemCommon { type: 'image'; material: string; fit?: 'cover' | 'contain'; radius?: number; mask?: 'ellipse' }
/** radius (rect only): corner radius as a fraction of the box's smaller side. */
export interface ShapeTrack extends ItemCommon { type: 'shape'; shape: 'rect' | 'ellipse'; color: Fill; radius?: number }
/** A video material in a box. fit default 'contain'; radius and mask as for a picture. */
export interface VideoTrack extends ItemCommon, FootageSpec { type: 'video'; material: string; fit?: 'cover' | 'contain'; radius?: number; mask?: 'ellipse' }
/**
 * bed: the track is the sound of a clip that runs on under several shots cut from that clip: its material is that video
 * material, 'in' is the source frame the sound starts at, and footage that starts inside its span is silent unless it
 * says "audio". A bed is not a sound of the video's own: footage outside its span keeps its automatic sound.
 */
/**
 * For ordinary audio, in is an offset in project frames; for a bed it uses the video material's source rate.
 * fadeOut: seconds over which the sound fades out where the video (or its span) cuts it off; a sound that has ended by
 * itself before that is left as it is. A fill's "sound" has one (retarget), so music longer than the video ends softly.
 */
/**
 * role: what the track is in the layered mix (timeline/mix.ts). 'voice': the voice-over; lines are the frames its
 * lines are spoken on, counted from the track's start, and other sound gives way on them. 'music': it lies under
 * everything and gives way to every speech, unless "gain" fixes its level. A project whose audio tracks (beds apart)
 * all have a role is mixed in layers: its clips keep their own sound. A track without a role is a sound of the
 * project's own as before: it keeps footage silent unless a use says "audio". 'sfx': a one-shot sound effect placed on
 * an event of the picture (popost video sfx place): it sits above the music and below speech, lowered a little while
 * someone speaks unless it is the "lead" of its moment. at: the frame of the video its file starts on (an effect is
 * placed by frame, not by segment); cue: the event it was placed for, for the record.
 */
export interface AudioTrack { id: string; type: 'audio'; material: string; gain?: number; during?: Span; note?: string; bed?: true; in?: number; fadeOut?: number; role?: 'voice' | 'music' | 'sfx'; lines?: [number, number][]; at?: number; lead?: true; cue?: string }

/** One caption: shown on its span (which may run past its segment), in the track's box, style, entrance and exit. */
export interface CaptionCue { text: string; during: Span; spans?: TextSpanStyle[]; note?: string }

/** Timed text in one box. Each cue becomes a text item "<track id>#<n>" (n: the cue's index from 0). Cues are in time
 *  order and do not overlap. */
export interface CaptionTrack {
  id: string;
  type: 'caption';
  box: Box;
  style?: string | TextStyle;
  enter?: MotionSpec;
  exit?: MotionSpec;
  z?: number;
  cues: CaptionCue[];
  /**
   * The audio track whose words the cues follow (true: the only audio track with words). Each cue's tokens are matched
   * to the words spoken inside the cue's span (src/align, forgiving), for style.spoken and reveal.
   */
  words?: string | boolean;
  /** 'words': each token of a cue appears when it is spoken. With a 'type' entrance it replaces its even pace. Needs words. */
  reveal?: 'words';
  note?: string;
}
export type Track = TextTrack | ImageTrack | ShapeTrack | VideoTrack | AudioTrack | CaptionTrack;
export type VisualTrack = TextTrack | ImageTrack | ShapeTrack | VideoTrack;

export interface Project {
  version: 1;
  canvas: Canvas;
  language?: string;
  materials: Material[];
  segments: Segment[];
  tracks: Track[];
  note?: string;
}

/**
 * What the build step reads from the file of a video material with probe() and gives to check and resolve: the size,
 * the frame rate and exact frame count, and whether it has sound. { error } when the file is not a video ffmpeg reads.
 */
export type FootageFacts = Pick<Probe, 'width' | 'height' | 'fps' | 'frames' | 'hasAudio'> & {
  /**
   * Seconds of source speech. Strict remakes use independently observed ASR timing, never requested line slots;
   * an unobserved first draft conservatively protects the whole speaking clip. Legacy projects keep receipt timing.
   * Such a clip is never muted by itself.
   */
  speech?: [number, number][];
  /** The mode the clip was made with, and the recorded basis of music made inside it (its receipt, <file>.mode.json; sound/modes.ts). */
  sound?: SoundMode;
  clipMusic?: string;
  /** Strict native speech measured from hash-bound actual ASR, independently of requested receipt slots. */
  speechObserved?: true;
};
export type FootageInfo = FootageFacts | { error: string };

/** One problem found by check: where, what, what is allowed, and one way to fix it. */
export interface Problem {
  level: 'error' | 'warning';
  /** JSON path, e.g. "tracks[2].during.segment". */
  at: string;
  message: string;
  allowed?: string[];
  fix?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Resolved timeline (the page runtime plays this; all defaults filled in, all times absolute frames)

export interface ResolvedTransition {
  kind: Exclude<TransitionKind, 'cut'>;
  /** First and last-plus-one mixed frame: the span is a .. a+F-1. */
  a: number;
  frames: number;
  /** S_k: where the new segment starts. */
  boundary: number;
  direction: WipeDirection;
  mode: 'push' | 'cover' | 'reveal';
  via: 'black' | 'white';
  ease: Ease;
  /** resolve() always writes both; absent reads as 'both' and 1. */
  side?: 'both' | 'after' | 'before';
  strength?: number;
}

/** A camera move in absolute frames, every default filled in. */
export interface ResolvedCameraMove {
  from: number;
  to: number;
  scale: [number, number];
  focus: [number, number];
  shift: [[number, number], [number, number]];
  ease: Ease;
}

/** A video material as the page shows it: one picture per source frame. */
export interface ResolvedFootage {
  /** The video file, relative to the project directory (its sound is mixed from it). */
  src: string;
  /** The source's own frame rate and exact number of frames. */
  fps: number;
  frames: number;
  /**
   * Directory of the frame pictures, relative to the project directory: source frame f is dir + '/' + f written with
   * at least 6 digits + '.jpg'. Set by the build step (compile/footage.ts), which extracts the frames the timeline
   * shows; absent after resolve() alone, and a page without it refuses to start (prepare() rejects).
   */
  dir?: string;
}

/** One use of a video material (a base or an item): the frame mapping of the header with i = n - start. */
export interface ResolvedPlay {
  /** Key into Resolved.footage. */
  material: string;
  /** The project frame where i = 0: the segment's or the item's start. */
  start: number;
  in: number;
  speed: number;
}

/**
 * A picture or video base's camera is the rate form (zoom, pan; both 0 = still) or, when moves is present, the moves
 * alone (zoom and pan are 0 then). A gradient base also has color: the stop nearest the middle, for whoever needs one
 * colour.
 */
export type ResolvedBase =
  | { kind: 'color'; color: string; gradient?: Gradient }
  | { kind: 'image'; src: string; fit: 'cover' | 'contain'; ground?: ResolvedGround; zoom: number; pan: [number, number]; moves?: ResolvedCameraMove[] }
  | { kind: 'video'; play: ResolvedPlay; fit: 'cover' | 'contain'; ground?: ResolvedGround; zoom: number; pan: [number, number]; moves?: ResolvedCameraMove[] }
  | ResolvedScene;

/** A scene base: the HTML file, as a URL relative to the page. */
export interface ResolvedScene { kind: 'scene'; src: string; slots?: Record<string, string>; offset?: number }

/** The ground of a material base: one colour, and the gradient when it is one. */
export interface ResolvedGround { color: string; gradient?: Gradient }

export interface ResolvedSegment {
  id: string;
  index: number;
  /** S_k and S_k+1 (exclusive). */
  start: number;
  end: number;
  base: ResolvedBase;
  /** The transition into this segment; absent for the first segment and for hard cuts. */
  transition?: ResolvedTransition;
}

export interface ResolvedMotion { preset: MotionPreset; frames: number; ease: Ease; overshoot: number; direction: Direction; distance: number }

/** A text style with every default filled in (shadow too, when there is one). */
export type ResolvedTextStyle = Required<Pick<TextStyle, 'font' | 'size' | 'weight' | 'color' | 'align' | 'italic'>> &
  Pick<TextStyle, 'stroke' | 'background' | 'letterSpacing' | 'lineHeight' | 'opacity' | 'spans' | 'spoken'> & { shadow?: Required<Shadow> };

/** A token of a caption cue that follows the words: characters from .. to-1 of its text (by code point), spoken on frames start .. end-1. */
export interface ResolvedWord { from: number; to: number; start: number; end: number }

export interface ResolvedLoop { preset: LoopPreset; period: number; amount: number }

export interface ResolvedItem {
  id: string;
  type: 'text' | 'image' | 'shape' | 'video';
  /** On screen on frames start .. end-1. */
  start: number;
  end: number;
  box: Box;
  z: number;
  enter: ResolvedMotion;
  exit: ResolvedMotion;
  text?: string;
  style?: ResolvedTextStyle;
  src?: string;
  fit?: 'cover' | 'contain';
  shape?: 'rect' | 'ellipse';
  /** shape: its colour; for a gradient, the stop nearest the middle (the gradient itself is in gradient). */
  color?: string;
  gradient?: Gradient;
  /** shape (rect), image and video: corner radius as a fraction of the box's smaller side. */
  radius?: number;
  /** image and video. */
  mask?: 'ellipse';
  /** video only. */
  play?: ResolvedPlay;
  /** Written only when not the default (0, 1, none). */
  rotate?: number;
  opacity?: number;
  border?: { color: string; width: number };
  shadow?: Required<Shadow>;
  loop?: ResolvedLoop;
  /** A caption cue: its track and its index among the cues. */
  cue?: { track: string; index: number };
  /** A caption cue that follows the words: one entry per token of its text, in order (style.spoken applies to them). */
  words?: ResolvedWord[];
  /** Each token appears when it is spoken (the track's reveal). A 'type' entrance is then resolved as 'none'. */
  reveal?: 'words';
}

/**
 * How a sound gives way to speech (timeline/mix.ts): lowered by db on the spans (timeline frames, start .. end-1), its
 * level going down over ramp frames before a span and coming back over ramp frames after it.
 */
export interface Duck {
  spans: [number, number][]; db: number; ramp: number;
  /**
   * Spans on which the sound gives way altogether (music under a clip that brings music of its own: one music source
   * at a time), lowered by its own db over its own, longer ramp. Added to the lowering above.
   */
  away?: { spans: [number, number][]; db: number; ramp: number };
}

export interface ResolvedAudio {
  id: string;
  src: string;
  start: number;
  end?: number;
  gain: number;
  /** Where in the file the sound starts: source frame 'frame' at the file's own rate 'fps' (footage: its "in"). Default 0. */
  from?: { frame: number; fps: number };
  /** Footage played faster or slower: its sound at the same rate (tempo changed, pitch kept). Default 1. */
  speed?: number;
  /** Seconds of fade-out before the place the video cuts the sound off (AudioTrack.fadeOut); the render drops it for a sound that ends before. */
  fadeOut?: number;
  /** The sound gives way to speech on these spans; absent: it plays at its gain throughout. */
  duck?: Duck;
}

export interface Resolved {
  canvas: Canvas;
  /** Total length in frames. */
  frames: number;
  segments: ResolvedSegment[];
  items: ResolvedItem[];
  audio: ResolvedAudio[];
  /** The video materials the timeline shows, by material id. resolve() always writes it; absent means none. */
  footage?: Record<string, ResolvedFootage>;
  /** Every font material, declared by the page under its id. resolve() always writes it; absent means none. */
  fonts?: { family: string; src: string }[];
  /** The words of every audio track that has them, in timeline frames (for the preview). Written only when there are any. */
  words?: { track: string; tokens: { text: string; start: number; end: number; confidence: number }[] }[];
  /**
   * When speech is heard, in timeline frames: the lines of the voice-over, and the lines the people of clips say (by
   * the id of the clip's sound). Written only when there is any; the checks hold one against the other.
   */
  speech?: { voice: [number, number][]; dialogue: { id: string; spans: [number, number][] }[] };
  /**
   * Where music is heard, in timeline frames: the music tracks (fixed: a track whose "gain" keeps it from giving way)
   * and the clips that bring music of their own (an exhibit, or a clip made with music on a recorded basis). Written
   * only when there is any; the check holds them to one source at a time (project/check-sound.ts).
   */
  music?: { tracks: { id: string; span: [number, number]; fixed: boolean }[]; clips: { id: string; span: [number, number]; exhibit: boolean; basis?: string }[] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Measurement (read from any video file by programs)

export interface Probe { width: number; height: number; fps: number; frames: number; duration: number; hasAudio: boolean }

export interface Boundary {
  /** Where the new shot takes over (for a hard cut: its first frame). */
  frame: number;
  kind: TransitionKind;
  /** The last frame that is purely the old shot, and the first that is purely the new one. A hard cut: frame-1, frame. */
  start: number;
  end: number;
  direction?: WipeDirection;
  mode?: 'push' | 'cover' | 'reveal';
  via?: 'black' | 'white';
  /** 0..1. */
  confidence: number;
  /**
   * How much of the in-between frames the kind's model leaves unexplained, 0..1: its residual relative to the change
   * across the span (0: the model explains every frame; 1: as wrong as showing the other picture), or for a kind read
   * from the switch (spin, shake, glitch, blur, one-sided) the share of frames no reading explains. Absent for a cut.
   * A large one means the label does not explain the frames: describe tells the reader to look at them.
   */
  residual?: number;
  /**
   * A moving edge (wipe, slide, whip) only: how far apart the edge stands across its travel when each of four bands
   * along it finds its own place, as a share of the frame (median over the frames). A straight edge: 0; a curved
   * edge, or one a moving shape leads, stands apart.
   */
  bend?: number;
}

export interface CameraMeasure {
  kind: 'static' | 'move' | 'unsteady' | 'unknown';
  /** Same units as CameraSpec. For a shot with moves: the mean rate over the whole shot. */
  zoomPerS: number;
  panPerS: [number, number];
  confidence: number;
  /**
   * Moves that start and stop inside the shot, when the camera does not run at one rate from end to end: frames of
   * the source (the move runs on start .. end-1), the scale before and after, and the point that stays in place
   * (fractions of the frame). Optional: a measurement that only fits a rate leaves it out.
   */
  moves?: { start: number; end: number; scale: [number, number]; focus?: [number, number] }[];
}

export interface MotionEvent {
  /** Frames of the source, at its native rate: the change runs on start .. end-1. */
  start: number;
  end: number;
  box: Box;
  kind: 'appear' | 'disappear' | 'change';
  /** How it appears or disappears, as far as the picture tells. */
  how?: 'instant' | 'fade' | 'slide' | 'scale' | 'wipe';
  direction?: Direction;
  ease?: Ease | 'instant';
  overshoot?: number;
  colour?: string;
  confidence: number;
}

export interface ShotMeasure {
  index: number;
  /** Frames start .. end-1, between the boundaries' frame values. */
  start: number;
  end: number;
  camera: CameraMeasure;
  /** Hex colours. */
  background: string;
  palette: { hex: string; share: number }[];
  events: MotionEvent[];
  /**
   * The share of the shot's middle picture that is not ground, 0..1 (measure/fill.ts, the function scene check uses):
   * written by describe, so that a scene can be held to its reference shot; absent in a measurement of a render.
   */
  fill?: number;
}

/**
 * How a value is known. measured: read off the pixels (or the sound) by a program; inferred: concluded from measured
 * facts or seen in the frames by a model, to be confirmed; unknown: could not be read. The same three words label the
 * values of a reading (Measure.known, the tags in describe's files) and the fields of elements.json.
 */
export const KNOWN_AS = ['measured', 'inferred', 'unknown'] as const;
export type KnownAs = (typeof KNOWN_AS)[number];
/** confidence: 0..1 where the measurement has one; basis: in a few words what the value rests on, or why it is not known. */
export interface Status { status: KnownAs; confidence?: number; basis: string }

/**
 * Something of a reference that was not recovered: what, where (a shot or the change into a shot, both numbered from 1
 * as the reading numbers them, and seconds of the reference), why, and how to settle it. One list for the whole chain:
 * describe fills it with what the programs could not read (by 'measurement'), the model that reads the frames appends
 * what it could not see to elements.json (by 'reader'), a template and a project keep it, and compare and the delivery
 * notes carry it forward with what was assumed instead.
 */
export interface Unrecovered {
  what: string;
  where: { shot?: number; transition?: number; time?: [number, number] };
  why: string;
  settle?: string;
  /** What the re-make does in its place. */
  assumed?: string;
  by?: 'measurement' | 'reader';
}

/** One sample of a trajectory: the frame, the centre and the size ([x, y] and [width, height], fractions of the canvas). */
export interface TrajectorySample {
  frame: number;
  centre: [number, number];
  size: [number, number];
  /** A transition's only: the share of the picture that already shows the new shot, 0..1. */
  cover?: number;
}

/** The way from a trajectory's first sample to its last. */
export interface TrajectoryPath {
  from: [number, number];
  to: [number, number];
  /** Degrees on screen, in pixels and not in fractions: 0 is to the right, 90 down, -90 up, 180 to the left. */
  angle: number;
  /** The straight way from 'from' to 'to' in canvas widths, and that way per second. */
  length: number;
  speed: number;
  /** The straight way as a share of the way gone: 1 is a straight line. */
  straightness: number;
  ease: Ease;
}

/**
 * The edge of the region that shows the new picture during a transition. shape: the model that parts the two pictures
 * best (irregular: none does); fit: the share of the smaller side the model puts on its right side of the edge, the
 * median over the frames of that shape; share: the share of the transition's frames that have that shape.
 */
export interface RevealEdge {
  shape: 'straight' | 'wedge' | 'circle' | 'irregular';
  fit: number;
  share: number;
  /** straight: where the edge travels; wedge: where its tip points. Degrees as in TrajectoryPath. */
  angle?: number;
  /** wedge: its opening in degrees. */
  spread?: number;
  /** circle: its centre (fractions of the canvas; it may lie outside), and whether the new picture is inside it. */
  centre?: [number, number];
  grows?: boolean;
}

/**
 * Where something was on screen over time (measure/tracks.ts). of 'transition': the region of the new picture during the
 * change into shot 'shot' (from 1), followed as the object at its front when a shape leads it (what 'object', method
 * 'reveal-front') or as the region's edge (what 'region', method 'reveal-region'). of 'event': an element of shot
 * 'shot' that travels while it appears or disappears (what 'element', method 'changed-region': the pixels that differ
 * from the picture without it), the event's index among the shot's events in 'event'. Valid on frames start .. end.
 */
export interface Trajectory {
  id: string;
  of: 'transition' | 'event';
  shot: number;
  event?: number;
  what: 'object' | 'region' | 'element';
  method: 'reveal-front' | 'reveal-region' | 'changed-region';
  start: number;
  end: number;
  /** At most 24, in order of frame, the first and the last kept. */
  samples: TrajectorySample[];
  path: TrajectoryPath;
  /** The median size over the samples. */
  size: [number, number];
  /** A transition's only: all of it, in frames (the first frame that shows the new picture to the first that shows only it), and its edge. */
  reveal?: { start: number; end: number; edge: RevealEdge };
  /** 0..1. */
  confidence: number;
}

export interface Measure {
  version: 1;
  source: Probe;
  boundaries: Boundary[];
  shots: ShotMeasure[];
  /**
   * How each value is known, by its path in this document ("boundaries[1].kind", "shots[2].camera", "tracks[0]"):
   * written by describe (describe/known.ts). Absent in a measurement of a render and in one written before it existed:
   * its values are then unlabelled.
   */
  known?: Record<string, Status>;
  /** Trajectories of what moves along a way (measure/tracks.ts). Absent in a measurement written before they existed. */
  tracks?: Trajectory[];
  /** How much of the picture changes between sampled frames, 0..1, one value every step frames. */
  rhythm: { step: number; change: number[] };
  /**
   * The motion amount (measure/amount.ts): the mean absolute change of the gray thumbnail between frames 'step' frames
   * apart, in levels of 255 per 1/15 s, one value every 'step' frames. Absent in a measurement written before it existed.
   */
  motion?: { step: number; amount: number[] };
  /** Small gray thumbnails sampled every 'every' frames, row by row, one byte per pixel, base64. For comparing pictures
   *  of two videos without decoding them again. */
  signature: { every: number; width: number; height: number; count: number; data: string };
}

// ---------------------------------------------------------------------------------------------------------------------
// Score (two measurements compared)

export const DIMENSIONS = ['structure', 'transitions', 'camera', 'motion', 'rhythm', 'colour', 'picture'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface DimensionScore {
  /** 0..1, 1 = the same. */
  score: number;
  /** How many things were compared (pairs, shots, samples). 0 = nothing to compare; the dimension is then left out of the composite. */
  n: number;
  detail: Record<string, number | string>;
}

export interface Score {
  dimensions: Record<Dimension, DimensionScore>;
  /** Weighted mean of the dimensions that had something to compare. */
  composite: number;
}
