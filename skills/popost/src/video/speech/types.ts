/**
 * What is said in a video, and when: words with times. Recognising speech needs a model, which does not live in this
 * package: a Transcriber is the interface, and the implementation is a command the developer or the server provides.
 */

export interface SpokenWord {
  /** One word; for Chinese, usually one or two characters. Punctuation stays attached to the word before it. */
  text: string;
  /** Frames of the source video: spoken on start .. end-1. */
  start: number;
  end: number;
  /** 0..1, the recogniser's own estimate. Names and coined words are often wrong and low. */
  confidence: number;
}

export interface Transcript {
  language: string;
  words: SpokenWord[];
  /** Frame rate the frame numbers refer to. */
  fps: number;
}

/** What a transcriber returns: seconds, as recognisers give them. */
export interface RawTranscript { language: string; words: { text: string; start: number; end: number; confidence: number }[] }

export interface Transcriber {
  /** file: a 16 kHz mono WAV. language: a hint such as "zh" or "en", or undefined to detect. */
  transcribe(file: string, language?: string): Promise<RawTranscript>;
}

/** A stretch of speech between two pauses. */
export interface Phrase { text: string; start: number; end: number; words: SpokenWord[]; confidence: number }
