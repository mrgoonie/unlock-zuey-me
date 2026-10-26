// Device pairing (RFC 8628 style, docs/insights-ingest-contract.md "Device pairing flow"):
// start → show userCode + verificationUri → poll every `interval` s until approved, denied or expired.
// The token goes straight into credentials.json and is never printed, so it never enters the agent chat.
import { updateState } from './local-state.mjs';
import { pairPoll, pairStart } from './ingest-client.mjs';
import { INGEST_TOKEN_PATTERN, PAIR_DEVICE_CODE_PATTERN, PAIR_USER_CODE_PATTERN, PAIR_VERIFICATION_PATH } from './constants.mjs';
import { writeCredentials } from './credentials.mjs';

/** RFC 8628 §3.5: on `slow_down` the client adds 5 s to its interval. The server rejects polls < 4 s apart. */
const SLOW_DOWN_STEP_MS = 5000;
const MIN_INTERVAL_MS = 5000;

export class PairingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PairingError';
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** Vietnamese message for a failed `pair/start`. */
function startFailure(status) {
  if (status === 404) return 'Tính năng ai-tutor chưa bật trên máy chủ (hoặc chưa mở cho tài khoản của bạn).';
  if (status === 429) return 'Bạn thử ghép nối quá nhiều lần, hãy đợi vài phút rồi thử lại.';
  if (status === 0) return 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.';
  return `Máy chủ từ chối yêu cầu ghép nối (HTTP ${status}).`;
}

/**
 * @param {{
 *   paths: ReturnType<typeof import('./paths.mjs').configPaths>,
 *   server: string,
 *   label: string,
 *   print: (line: string) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} args
 * @returns {Promise<{ expiresAt: string }>}
 */
export async function pairDevice({ paths, server, label, print, sleep = sleepMs, now = Date.now }) {
  const start = await pairStart(server, label);
  if (start.status !== 200 || !start.body) throw new PairingError(startFailure(start.status));
  const { deviceCode, userCode, interval, expiresIn } = start.body;
  if (typeof deviceCode !== 'string' || !PAIR_DEVICE_CODE_PATTERN.test(deviceCode) || typeof userCode !== 'string' || !PAIR_USER_CODE_PATTERN.test(userCode)) {
    throw new PairingError('Máy chủ trả về dữ liệu ghép nối không hợp lệ.');
  }
  // The approval page is always built from the server this CLI talks to (never a host taken from the response), so
  // a tampered response cannot send the learner to another site. `?code=` pre-fills the code on /insights/pair.
  const pairUrl = `${server}${PAIR_VERIFICATION_PATH}`;
  print(`Mã ghép nối: ${userCode}`);
  print(`Mở ${pairUrl}?code=${userCode} trên trình duyệt (đã đăng nhập zuey.me), kiểm tra mã ${userCode} trùng khớp rồi bấm Đồng ý.`);
  print(`(Hoặc mở ${pairUrl} và nhập mã ${userCode}.)`);
  print('Đang chờ bạn xác nhận… (mã hết hạn sau 10 phút)');

  let waitMs = Math.max(MIN_INTERVAL_MS, Number.isInteger(interval) ? interval * 1000 : MIN_INTERVAL_MS);
  const ttlMs = Math.min(Number.isInteger(expiresIn) && expiresIn > 0 ? expiresIn : 600, 900) * 1000;
  const deadline = now() + ttlMs;
  while (now() < deadline) {
    await sleep(waitMs);
    const res = await pairPoll(server, deviceCode);
    if (res.status === 200) {
      const token = res.body?.token;
      if (typeof token !== 'string' || !INGEST_TOKEN_PATTERN.test(token)) throw new PairingError('Máy chủ trả về token không hợp lệ.');
      const expiresAt = typeof res.body.expiresAt === 'string' ? res.body.expiresAt : '';
      writeCredentials(paths, { server, token, label, expiresAt });
      updateState(paths, { credentialsInvalid: false, serverBlockedUntil: 0, uploadRetryAfter: 0, blockReason: null });
      return { expiresAt };
    }
    if (res.status === 428) continue;
    if (res.status === 429) { waitMs += SLOW_DOWN_STEP_MS; continue; }
    if (res.status === 410) {
      throw new PairingError(res.body?.status === 'denied' ? 'Bạn đã từ chối mã ghép nối này.' : 'Mã ghép nối đã hết hạn. Chạy lại lệnh pair.');
    }
    if (res.status === 0 || res.status >= 500) continue; // transient; keep polling until the code expires
    throw new PairingError(`Ghép nối thất bại (HTTP ${res.status}).`);
  }
  throw new PairingError('Mã ghép nối đã hết hạn. Chạy lại lệnh pair.');
}
