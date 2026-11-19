/** Minimal typings for the parts of CodeMirror 5 the code panel uses (the package ships none). */
declare module 'codemirror' {
  export interface Editor {
    getValue(): string;
    setValue(value: string): void;
    on(event: 'change', handler: () => void): void;
    setOption(name: string, value: unknown): void;
    refresh(): void;
    toTextArea(): void;
    focus(): void;
  }
  interface CodeMirrorStatic {
    fromTextArea(textarea: HTMLTextAreaElement, options?: Record<string, unknown>): Editor;
  }
  const CodeMirror: CodeMirrorStatic;
  export default CodeMirror;
}
declare module 'codemirror/mode/*';
