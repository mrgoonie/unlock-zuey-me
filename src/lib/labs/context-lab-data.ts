/**
 * Authored data for the "Phòng thí nghiệm ngữ cảnh" lab: context cards with one answer per card
 * combination, a long chat for the context-window demo, the "new chat" demo and three check questions.
 */
export interface ContextCard {
  id: string;
  emoji: string;
  label: string;
  text: string;
}

export const PLAN_QUESTION = 'Gợi ý giúp mình kế hoạch đi chơi Chủ nhật này nhé.';

export const CONTEXT_CARDS: ContextCard[] = [
  { id: 'budget', emoji: '💰', label: 'Ngân sách', text: 'Cả ngày chỉ tiêu tối đa 500.000đ.' },
  { id: 'people', emoji: '👵', label: 'Đi cùng ai', text: 'Đi cùng mẹ 60 tuổi và bé 5 tuổi.' },
  { id: 'knee', emoji: '🦵', label: 'Ràng buộc', text: 'Mẹ đau gối, không đi bộ hay leo dốc nhiều.' },
];

export const CARD_ORDER = CONTEXT_CARDS.map((c) => c.id);

/** One answer per combination of cards, keyed by contextKey() (card ids in CARD_ORDER joined by "+"). */
export const PLAN_VARIANTS: Record<string, string> = {
  '': 'Sáng leo núi ngắm bình minh, trưa ăn buffet hải sản, chiều chơi trò mạo hiểm ở khu vui chơi, tối xem phim. Một ngày thật "cháy"!',
  budget: 'Với 500.000đ: sáng dạo công viên (miễn phí), trưa ăn cơm quán bình dân, chiều ngồi cà phê bờ sông, tối về nhà nấu lẩu.',
  people: 'Đi ba thế hệ thì chọn chỗ có ghế nghỉ và đồ chơi cho bé: sáng sở thú, trưa nhà hàng có khu trẻ em, chiều về sớm cho bé ngủ trưa.',
  knee: 'Tránh leo núi và đi bộ xa: xem phim buổi sáng, trưa ăn nhà hàng gần bãi gửi xe, chiều cà phê sân vườn có ghế ngồi thoải mái.',
  'budget+people':
    'Ba người, 500.000đ: sáng công viên có sân chơi cho bé, trưa cơm nhà mang theo, chiều ăn kem. Nhớ kiểm tra giá vé trẻ em trước khi đi.',
  'budget+knee':
    'Tiết kiệm mà nhẹ chân: sáng cà phê sân vườn gần nhà, trưa ăn quán quen, chiều xem phim suất sớm (rẻ hơn), đi xe tận cửa.',
  'people+knee':
    'Bà đau gối, bé còn nhỏ: chọn khu vui chơi trong nhà ở trung tâm thương mại có thang máy, bà ngồi nghỉ ở quán nước, bé chơi gần đó.',
  'budget+people+knee':
    'Gợi ý vừa túi tiền, nhẹ chân cho bà, vui cho bé: sáng sân chơi trong trung tâm thương mại gần nhà (bà ngồi ghế trông), trưa cơm nhà, chiều đi xe ra công viên ngồi ăn kem. Tổng khoảng 300–400k, nhớ kiểm tra giá trước.',
};

export interface WindowMessage {
  id: string;
  role: 'user' | 'ai';
  text: string;
}

/** Long chat for the context-window demo. The first message is the one that "falls off". */
export const WINDOW_CHAT: WindowMessage[] = [
  { id: 'm1', role: 'user', text: 'Nhắc trước nhé: mình bị dị ứng tôm.' },
  { id: 'm2', role: 'ai', text: 'Mình nhớ rồi, sẽ tránh tôm trong mọi gợi ý.' },
  { id: 'm3', role: 'user', text: 'Tuần này mình muốn ăn nhẹ, ít dầu mỡ.' },
  { id: 'm4', role: 'ai', text: 'Được, mình ưu tiên món luộc, hấp và canh.' },
  { id: 'm5', role: 'user', text: 'Nhà có hai người lớn thôi.' },
  { id: 'm6', role: 'ai', text: 'Vậy mỗi món nấu khoảng hai phần là vừa.' },
  { id: 'm7', role: 'user', text: 'Thứ Sáu mình về muộn, cần món nấu dưới 20 phút.' },
  { id: 'm8', role: 'ai', text: 'Thứ Sáu làm trứng hấp và rau luộc cho nhanh nhé.' },
  { id: 'm9', role: 'user', text: 'Gợi ý món tối nay đi.' },
];

export const ALLERGY_MESSAGE_ID = 'm1';

/** Window sizes in approximate tokens: the small one loses the first message by the end of the chat. */
export const WINDOW_SIZES = { small: 120, large: 200 } as const;

export const DINNER_ANSWERS = {
  remembers: 'Tối nay nấu canh bí đỏ thịt băm và cá hấp gừng nhé: nhẹ, ít dầu, không có tôm.',
  forgot: 'Tối nay làm gỏi cuốn tôm thịt nhé, nhẹ nhàng mà nhanh!',
};

export const NEW_CHAT = {
  ask: 'Lên thực đơn tối nay theo đúng những gì mình đã dặn nhé.',
  blankAnswer: 'Bạn chưa dặn mình điều gì trong cuộc trò chuyện này. Bạn có kiêng món nào không, nhà mấy người?',
  summary: 'Tóm tắt: dị ứng tôm, ăn nhẹ ít dầu, nhà 2 người lớn, Thứ Sáu cần món dưới 20 phút.',
  answerWithSummary: 'Đã rõ! Tối nay: canh rau ngót thịt bằm, đậu hũ hấp, trái cây tráng miệng. Không có tôm, ít dầu, đủ 2 người.',
};

export interface CheckQuestion {
  id: string;
  prompt: string;
  options: string[];
  correct: number;
  explain: string;
}

export const CHECKS: Record<'plan' | 'window' | 'newChat', CheckQuestion> = {
  plan: {
    id: 'plan',
    prompt: 'Lúc chưa có thẻ nào, vì sao AI gợi ý leo núi và buffet hải sản?',
    options: ['AI muốn bạn tiêu thật nhiều tiền', 'AI không biết gì về bạn nên đoán kiểu phổ biến', 'AI bị lỗi'],
    correct: 1,
    explain: 'AI chỉ dùng những gì có trên "bàn". Thiếu thông tin thì nó điền bằng gợi ý phổ biến nhất.',
  },
  window: {
    id: 'window',
    prompt: 'Với bàn nhỏ, vì sao AI gợi ý món có tôm?',
    options: ['Tin nhắn dặn dị ứng đã rơi khỏi bàn', 'AI cố tình không nghe lời', 'AI không hiểu tiếng Việt'],
    correct: 0,
    explain: 'Cuộc trò chuyện dài quá sức chứa thì phần đầu bị cắt. Điều quan trọng nên nhắc lại ở cuối.',
  },
  newChat: {
    id: 'newChat',
    prompt: 'Mở cuộc trò chuyện mới, cách nhanh nhất để AI làm đúng ý bạn là gì?',
    options: ['Nói "như lần trước nhé"', 'Hỏi lại nhiều lần cho tới khi đúng', 'Dán lại bản tóm tắt những điều quan trọng'],
    correct: 2,
    explain: 'Chat mới là bàn trống. Một đoạn tóm tắt ngắn giúp AI "nhớ" lại ngay.',
  },
};
