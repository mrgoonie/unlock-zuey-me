/**
 * Shared redaction rules (skills/ai-unlocked/scripts/lib/redact.mjs): imported through the same relative
 * path the Worker uses, so the client and server run one rule set.
 */
import { describe, expect, it } from 'vitest';
import { REDACT_MAX_INPUT, redactText, redactValue } from '../../skills/ai-unlocked/scripts/lib/redact.mjs';

const KEY = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY'; // 32 mixed-case alphanumerics

const positives: Array<{ name: string; input: string; kind: string; secret: string }> = [
  { name: 'PEM private key', input: `here:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7\n-----END RSA PRIVATE KEY-----\nend`, kind: 'private_key', secret: 'MIIEpAIBAAKCAQEA7' },
  { name: 'unterminated PEM', input: `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA`, kind: 'private_key', secret: 'b3BlbnNzaC1rZXktdjEAAAAA' },
  { name: 'Anthropic key', input: `ANTHROPIC=sk-ant-api03-${KEY}`, kind: 'api_key', secret: KEY },
  { name: 'OpenAI key', input: `dùng key sk-proj-${KEY} nhé`, kind: 'api_key', secret: KEY },
  { name: 'OpenRouter key', input: `sk-or-v1-${KEY}`, kind: 'api_key', secret: KEY },
  { name: 'GitHub classic token', input: `ghp_${KEY}1234`, kind: 'github_token', secret: KEY },
  { name: 'GitHub OAuth token', input: `gho_${KEY}`, kind: 'github_token', secret: KEY },
  { name: 'GitHub fine-grained PAT', input: `github_pat_11ABCDEFG_${KEY}`, kind: 'github_token', secret: KEY },
  { name: 'AWS access key id', input: 'id AKIAIOSFODNN7EXAMPLE ok', kind: 'aws_key', secret: 'AKIAIOSFODNN7EXAMPLE' },
  { name: 'AWS secret key', input: 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', kind: 'aws_secret', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  { name: 'Slack token', input: 'xoxb-123456789012-abcdefABCDEF', kind: 'slack_token', secret: 'xoxb-123456789012' },
  { name: 'Google API key', input: 'AIzaSyD-1234567890abcdefghijklmnopqrstu', kind: 'google_key', secret: 'AIzaSyD-1234567890' },
  { name: 'JWT', input: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', kind: 'jwt', secret: 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' },
  { name: 'Authorization bearer', input: 'Authorization: Bearer abc.def-ghi_123456', kind: 'bearer', secret: 'abc.def-ghi_123456' },
  { name: 'ingest token', input: `token aiu_ing_${KEY}0123456789A`, kind: 'ingest_token', secret: KEY },
  { name: 'password assignment', input: 'password=hunter2!', kind: 'secret', secret: 'hunter2!' },
  { name: 'JSON secret', input: '{"client_secret": "s3cr3t-value"}', kind: 'secret', secret: 's3cr3t-value' },
  { name: 'env api key', input: 'MY_API_KEY=abcd1234', kind: 'secret', secret: 'abcd1234' },
  { name: 'Vietnamese password label', input: 'mật khẩu: matkhau123', kind: 'secret', secret: 'matkhau123' },
  { name: 'URL token param', input: 'https://x.example/cb?code=abc123&state=ok', kind: 'url_secret', secret: 'abc123' },
  { name: 'URL signature param', input: 'https://r2.example/f.png?X-Id=1&sig=Zm9vYmFy', kind: 'url_secret', secret: 'Zm9vYmFy' },
  { name: 'email', input: 'liên hệ duy.nguyen+ai@example.com.vn nhé', kind: 'email', secret: 'duy.nguyen+ai@example.com.vn' },
  { name: 'VN phone 0', input: 'gọi 0912345678 nhé', kind: 'phone', secret: '0912345678' },
  { name: 'VN phone +84 spaced', input: 'gọi +84 912 345 678', kind: 'phone', secret: '912 345 678' },
  { name: 'CCCD labelled', input: 'Số CCCD: 001203004567', kind: 'national_id', secret: '001203004567' },
  { name: 'CMND labelled', input: 'CMND 123456789', kind: 'national_id', secret: '123456789' },
  { name: 'căn cước labelled', input: 'căn cước 079203001234', kind: 'national_id', secret: '079203001234' },
  { name: 'standalone 12 digits', input: 'mã 038095001122 đây', kind: 'national_id', secret: '038095001122' },
  { name: 'card number', input: 'thẻ 4111 1111 1111 1111 hết hạn', kind: 'card', secret: '4111 1111 1111 1111' },
  { name: 'card number dashed', input: 'thẻ 5555-5555-5555-4444', kind: 'card', secret: '5555-5555-5555-4444' },
  { name: 'IBAN', input: 'IBAN DE89 3704 0044 0532 0130 00', kind: 'iban', secret: 'DE89 3704' },
  { name: 'IPv4', input: 'server 203.162.4.191 down', kind: 'ip', secret: '203.162.4.191' },
  { name: 'long hex', input: 'hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', kind: 'high_entropy', secret: '9f86d081884c7d659a2feaa0c55ad015' },
  { name: 'long base64', input: `blob ${KEY}Qz9+/=`, kind: 'high_entropy', secret: KEY },
];

describe('redactText: positives', () => {
  for (const c of positives) {
    it(`masks ${c.name}`, () => {
      const r = redactText(c.input);
      expect(r.text).not.toContain(c.secret);
      expect(r.text).toContain(`[REDACTED:${c.kind}]`);
      expect(r.kinds).toContain(c.kind);
      expect(r.count).toBeGreaterThan(0);
    });
  }

  it('replaces home directories with ~ instead of a marker', () => {
    expect(redactText('mở /Users/duynguyen/www/app/src').text).toBe('mở ~/www/app/src');
    expect(redactText('ls /home/lan/projects').text).toBe('ls ~/projects');
    expect(redactText('C:\\Users\\Lan\\Desktop\\a.txt').text).toBe('~\\Desktop\\a.txt');
    expect(redactText('/Users/duy/x').kinds).toEqual(['home_path']);
  });

  it('keeps the label and only masks the value', () => {
    expect(redactText('password=hunter2!').text).toBe('password=[REDACTED:secret]');
    expect(redactText('Authorization: Bearer abc.def-ghi_123456').text).toBe('Authorization: Bearer [REDACTED:bearer]');
    expect(redactText('Số CCCD: 001203004567').text).toBe('Số CCCD: [REDACTED:national_id]');
  });

  it('counts each replacement and reports sorted distinct kinds', () => {
    const r = redactText('a@b.co và c@d.co, gọi 0912345678');
    expect(r.count).toBe(3);
    expect(r.kinds).toEqual(['email', 'phone']);
  });
});

describe('redactText: negatives', () => {
  const untouched = [
    'Mình đang học cách viết prompt rõ ràng hơn cho nhiệm vụ lập kế hoạch cuối tuần.',
    'Hãy kiểm chứng câu trả lời của AI bằng hai nguồn độc lập trước khi tin.',
    'Token là đơn vị nhỏ nhất mà mô hình xử lý; mỗi câu có khoảng 20 token.',
    'max_tokens: 900 và temperature 0.2',
    'Lỗi ở src/lib/insights/feature-flags.ts dòng 42',
    'mcp__ai-unlocked__start_mission chạy ok',
    'run id 550e8400-e29b-41d4-a716-446655440000',
    'Ngày 2026-10-26 lúc 23:05, giá 150.000đ',
    'localhost 127.0.0.1:4321 và 0.0.0.0',
    'Phiên bản 1.2.3, số điện thoại bàn 028 3823 4567',
    'https://unlock.zuey.me/missions/plan-weekend?step=intro',
    'Thẻ 4111 1111 1111 1112 sai checksum',
  ];
  for (const text of untouched) {
    it(`leaves "${text.slice(0, 40)}" intact`, () => {
      expect(redactText(text)).toEqual({ text, count: 0, kinds: [] });
    });
  }

  it('handles empty and non-string input', () => {
    expect(redactText('')).toEqual({ text: '', count: 0, kinds: [] });
    expect(redactText(undefined as unknown as string)).toEqual({ text: '', count: 0, kinds: [] });
  });
});

describe('redactText: idempotence and limits', () => {
  it('finds nothing new on already-redacted text', () => {
    // An unterminated PEM block is redacted to the end of the input, so it goes last.
    const all = [...positives.filter((c) => c.name !== 'unterminated PEM'), positives[1]].map((c) => c.input).join('\n');
    const once = redactText(all);
    expect(once.count).toBeGreaterThanOrEqual(positives.length);
    expect(redactText(once.text)).toEqual({ text: once.text, count: 0, kinds: [] });
  });

  it('caps input before running the rules', () => {
    expect(redactText('a'.repeat(REDACT_MAX_INPUT + 100)).text.length).toBe(REDACT_MAX_INPUT);
  });

  // Guards against catastrophic (super-linear) regex backtracking, which costs seconds on 32 KB. The bound is
  // loose and uses the fastest of 3 runs so a slow or busy CI runner cannot fail it on wall-clock noise.
  it('runs 32 KB of adversarial input per rule family in well under a second each', () => {
    const inputs = [
      '1'.repeat(32_768),
      '1 '.repeat(16_384),
      'a'.repeat(32_768),
      'aA1'.repeat(10_923),
      '@a.'.repeat(10_923),
      'password='.repeat(3_641),
      '-----BEGIN A-----'.repeat(1_927),
      'eyJ'.repeat(10_923),
      '0.'.repeat(16_384),
      'sk-'.repeat(10_923),
      '/Users/'.repeat(4_681),
      'CCCD '.repeat(6_553),
    ];
    for (const input of inputs) {
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const t0 = performance.now();
        redactText(input);
        best = Math.min(best, performance.now() - t0);
      }
      expect(best, input.slice(0, 12)).toBeLessThan(250);
    }
  });
});

describe('redactValue', () => {
  it('redacts every nested string, keeps keys and non-strings, and sums counts', () => {
    const r = redactValue({
      userPrompt: 'mail tôi a@b.co',
      tools: [{ name: 'Bash', ok: true, count: 2 }],
      nested: { deeper: ['sk-ant-api03-' + KEY, null, 3] },
    });
    expect(r.value).toEqual({
      userPrompt: 'mail tôi [REDACTED:email]',
      tools: [{ name: 'Bash', ok: true, count: 2 }],
      nested: { deeper: ['[REDACTED:api_key]', null, 3] },
    });
    expect(r.count).toBe(2);
    expect(r.kinds).toEqual(['api_key', 'email']);
  });

  it('drops undefined properties and nulls values nested too deeply', () => {
    let deep: unknown = 'a@b.co';
    for (let i = 0; i < 20; i++) deep = [deep];
    const r = redactValue({ a: undefined, deep });
    expect(r.value).not.toHaveProperty('a');
    expect(JSON.stringify(r.value)).not.toContain('a@b.co');
  });
});
