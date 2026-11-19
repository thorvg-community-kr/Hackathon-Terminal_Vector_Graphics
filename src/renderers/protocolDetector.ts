export type TerminalProtocol = 'kitty' | 'iterm2' | 'unicode';

const KITTY_TERM_PROGRAMS = new Set(['ghostty', 'kitty', 'wezterm']);
const ITERM2_TERM_PROGRAMS = new Set(['iterm.app', 'warpterminal', 'rio']);
const TTYD_BIN_RE = /(^|[\\/])ttyd$/i;

/**
 * 멀티플렉서(tmux/screen) 또는 웹 터미널(ttyd) 환경에서는 부모 환경변수가 상속되더라도
 * 원시 그래픽 시퀀스가 깨진 문자열로 출력될 수 있으므로 유니코드 폴백 대상으로 판별한다.
 */
export function isUnsupportedMultiplexerOrWeb(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (Boolean(env.TMUX) || Boolean(env.STY)) {
    return true;
  }

  const term = (env.TERM ?? '').toLowerCase();
  if (term === 'dumb' || term.startsWith('screen')) {
    return true;
  }

  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();
  if (
    env.TERMVG_WEB === '1' ||
    termProgram === 'ttyd' ||
    TTYD_BIN_RE.test(env._ ?? '')
  ) {
    return true;
  }

  return false;
}

/**
 * 현재 터미널 환경변수에 기반해 최적의 그래픽 출력 프로토콜을 결정론적으로 감지한다.
 */
export function detectTerminalProtocol(
  env: NodeJS.ProcessEnv = process.env,
): TerminalProtocol {
  if (isUnsupportedMultiplexerOrWeb(env)) {
    return 'unicode';
  }

  const term = (env.TERM ?? '').toLowerCase();
  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();

  if (
    Boolean(env.KITTY_WINDOW_ID) ||
    term === 'xterm-kitty' ||
    Boolean(env.GHOSTTY_RESOURCES_DIR) ||
    term === 'xterm-ghostty' ||
    KITTY_TERM_PROGRAMS.has(termProgram)
  ) {
    return 'kitty';
  }

  if (
    Boolean(env.ITERM_SESSION_ID) ||
    env.LC_TERMINAL === 'iTerm2' ||
    ITERM2_TERM_PROGRAMS.has(termProgram)
  ) {
    return 'iterm2';
  }

  return 'unicode';
}
