// Native terminal palettes. The ANSI colors style what each CLI prints; the
// highlight colors tint only text the CLI left in its default color.
export const terminalThemes = {
  dark: {
    background: '#191b20', foreground: '#e9e9ee', cursor: '#f2f1fa', cursorAccent: '#191b20',
    selectionBackground: '#434b65', selectionInactiveBackground: '#343a4d',
    scrollbarSliderBackground: 'rgba(137,144,158,.22)', scrollbarSliderHoverBackground: 'rgba(137,144,158,.36)',
    scrollbarSliderActiveBackground: 'rgba(137,144,158,.48)',
    black: '#202228', red: '#f2777a', green: '#9bd08a', yellow: '#e8c37a',
    blue: '#7aa7f5', magenta: '#c792ea', cyan: '#6fcfd9', white: '#c9ccd6',
    brightBlack: '#89909e', brightRed: '#ff8f8f', brightGreen: '#b4e3a1', brightYellow: '#f2d68f',
    brightBlue: '#9bbcff', brightMagenta: '#d7aefb', brightCyan: '#8be3ea', brightWhite: '#f2f3f7',
  },
  light: {
    background: '#fcfcfc', foreground: '#24262c', cursor: '#24262c', cursorAccent: '#fcfcfc',
    selectionBackground: '#c4d6fb', selectionInactiveBackground: '#dde6f8',
    scrollbarSliderBackground: 'rgba(101,105,115,.2)', scrollbarSliderHoverBackground: 'rgba(101,105,115,.32)',
    scrollbarSliderActiveBackground: 'rgba(101,105,115,.44)',
    black: '#22242b', red: '#cf3c44', green: '#2e8540', yellow: '#9a6a00',
    blue: '#2f63d6', magenta: '#8a3fc6', cyan: '#0f7f8c', white: '#b9bac0',
    brightBlack: '#656973', brightRed: '#e05158', brightGreen: '#3a9a4e', brightYellow: '#b07d0a',
    brightBlue: '#4a7ef0', brightMagenta: '#a057db', brightCyan: '#1795a3', brightWhite: '#d5d6da',
  },
}

// Each color keeps at least 4.5:1 contrast on its terminal background. An
// object adds a background: inline code chips and full-width diff rows.
export const highlightColors = {
  dark: {
    url: '#78b4ff', path: '#5fd0dc', number: '#f2a65e', string: '#9fd68a',
    code: { foreground: '#f4a3c8', background: '#2a2d37' },
    keyword: '#c69cf4', func: '#7ab0ff', type: '#e5c07b', comment: '#7d8594',
    error: '#ff7b7b', warn: '#ecc265', ok: '#8bd68c', info: '#7ab0ff', hash: '#d2a8ff',
    added: { foreground: '#8bd68c', background: '#1d2b23' }, removed: { foreground: '#ff8b8b', background: '#332328' },
    hunk: '#5fd0dc', heading: '#7ab0ff', key: '#93b7ec', flag: '#e5c07b', punct: '#a4baff',
  },
  light: {
    url: '#1f5fd1', path: '#0b7285', number: '#b35309', string: '#2b7a32',
    code: { foreground: '#b5306b', background: '#f0f1f5' },
    keyword: '#8239c7', func: '#2257c9', type: '#8a6100', comment: '#6c7380',
    error: '#c62f37', warn: '#8f5e00', ok: '#24803a', info: '#2257c9', hash: '#8a3fc6',
    added: { foreground: '#24803a', background: '#eaf6ed' }, removed: { foreground: '#c62f37', background: '#fcecee' },
    hunk: '#0b7285', heading: '#2257c9', key: '#355fa8', flag: '#8a6100', punct: '#3f5fd6',
  },
}
