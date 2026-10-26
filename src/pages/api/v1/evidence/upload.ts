import { allowRequest } from '../../../../lib/coach/rate-limit';
import { apiError, json } from '../../../../lib/http/api-response';
import { EVIDENCE_MAX_BYTES, storeEvidenceImage } from '../../../../lib/learning/service';
import { withLearner } from '../_route-helpers';

/** Multipart overhead allowance on top of the image limit when pre-checking Content-Length. */
const MULTIPART_SLACK = 64 * 1024;

/** POST /api/v1/evidence/upload (multipart `file`, image ≤ 5 MB, type sniffed from bytes) → { key } */
export const POST = withLearner(async ({ request }, learner, deps) => {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > EVIDENCE_MAX_BYTES + MULTIPART_SLACK) return apiError('invalid', 'Ảnh quá lớn (tối đa 5 MB).');
  if (!(await allowRequest(deps.env.CACHE, 'upload', learner.id, new Date()))) {
    return apiError('rate_limited', 'Bạn tải ảnh hơi nhanh. Đợi một phút rồi thử lại nhé.');
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return apiError('invalid', 'Cần gửi ảnh dạng multipart với trường "file".');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return apiError('invalid', 'Thiếu tệp ảnh (trường "file").');
  if (file.size > EVIDENCE_MAX_BYTES) return apiError('invalid', 'Ảnh quá lớn (tối đa 5 MB).');
  const key = await storeEvidenceImage(deps.env, learner, new Uint8Array(await file.arrayBuffer()));
  return json({ key });
});
