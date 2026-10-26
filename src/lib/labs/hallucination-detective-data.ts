/**
 * Authored cases for the "Thám tử ảo giác" lab. Each case is a realistic AI-style answer split into claims.
 * Names such as "Ngân hàng An Phú" and the URLs are fictional on purpose.
 */
import type { Claim } from './detective-scoring';

export interface DetectiveCase {
  id: string;
  emoji: string;
  /** What the learner asked the AI. */
  question: string;
  claims: Claim[];
}

export const DETECTIVE_CASES: DetectiveCase[] = [
  {
    id: 'dalat',
    emoji: '🌲',
    question: 'Cuối tuần này mình đi Đà Lạt, có gì cần biết không?',
    claims: [
      {
        id: 'dalat-climate',
        text: 'Đà Lạt nằm trên cao nguyên nên khí hậu mát mẻ quanh năm, buổi tối khá lạnh.',
        accepted: ['verified'],
        explain: 'Kiến thức phổ biến, ít thay đổi theo thời gian. Có thể tin, nhưng xem thêm dự báo thời tiết trước khi đi.',
        flags: [],
      },
      {
        id: 'dalat-ticket',
        text: 'Vé vào thác Datanla là 50.000đ, mở cửa từ 7h00 đến 17h00 mỗi ngày.',
        accepted: ['needs_lookup'],
        explain: 'Giá vé và giờ mở cửa thay đổi thường xuyên. Con số càng cụ thể càng phải tra trang chính thức hoặc Google Maps.',
        flags: ['number'],
      },
      {
        id: 'dalat-hotel',
        text: 'Bạn nên ở khu hồ Xuân Hương vì đó là lựa chọn hợp túi tiền của bạn nhất.',
        accepted: ['insufficient'],
        explain: 'Bạn chưa hề nói ngân sách. AI đang đoán về bạn. Hãy cho AI biết ngân sách rồi hỏi lại.',
        flags: [],
      },
      {
        id: 'dalat-url',
        text: 'Đặt vé xe giường nằm giá tốt tại www.xedalat-chinhhang.vn/khuyen-mai.',
        accepted: ['needs_lookup'],
        explain: 'AI hay "bịa" đường link trông rất thật. Đừng nhập thông tin thanh toán vào link chưa kiểm chứng.',
        flags: ['url'],
      },
    ],
  },
  {
    id: 'headache',
    emoji: '🤕',
    question: 'Mẹ mình dạo này hay đau đầu buổi chiều, nên làm gì?',
    claims: [
      {
        id: 'headache-water',
        text: 'Uống đủ nước và ngủ đủ giấc có thể giúp giảm một số cơn đau đầu nhẹ.',
        accepted: ['verified'],
        explain: 'Lời khuyên chung, an toàn và phổ biến. Không thay cho việc đi khám nếu đau kéo dài.',
        flags: [],
      },
      {
        id: 'headache-study',
        text: 'Theo nghiên cứu của Đại học Harvard năm 2023, 87% cơn đau đầu buổi chiều là do thiếu magie.',
        accepted: ['needs_lookup'],
        explain: 'Trích dẫn kèm con số rất chính xác là dấu hiệu dễ bịa. Hãy tìm chính bài nghiên cứu đó, thường là không tồn tại.',
        flags: ['citation', 'number'],
      },
      {
        id: 'headache-dose',
        text: 'Mẹ bạn cứ uống 2 viên giảm đau mỗi 4 tiếng là ổn, không cần đi khám.',
        accepted: ['expert', 'needs_lookup'],
        explain: 'Liều thuốc phụ thuộc tuổi, bệnh nền, thuốc đang dùng. Đây là việc của bác sĩ hoặc dược sĩ, không phải AI.',
        flags: ['number'],
      },
      {
        id: 'headache-cause',
        text: 'Đau đầu của mẹ bạn chắc chắn là do căng thẳng công việc.',
        accepted: ['insufficient', 'expert'],
        explain: 'AI không biết gì về sức khoẻ của mẹ bạn. "Chắc chắn" ở đây là đoán. Chẩn đoán cần bác sĩ.',
        flags: [],
      },
    ],
  },
  {
    id: 'savings',
    emoji: '🏦',
    question: 'Mình có ít tiền tiết kiệm, nên gửi ngân hàng thế nào cho lợi?',
    claims: [
      {
        id: 'savings-term',
        text: 'Thông thường, gửi kỳ hạn dài có lãi suất cao hơn kỳ hạn ngắn, nhưng rút trước hạn sẽ bị giảm lãi.',
        accepted: ['verified'],
        explain: 'Nguyên tắc chung, đúng ở hầu hết ngân hàng. Chi tiết cụ thể vẫn xem biểu lãi của ngân hàng bạn chọn.',
        flags: [],
      },
      {
        id: 'savings-rate',
        text: 'Tuần trước, Ngân hàng An Phú vừa tăng lãi suất kỳ hạn 12 tháng lên 7,2%/năm.',
        accepted: ['needs_lookup'],
        explain: 'Tin "tuần trước" có thể nằm sau mốc kiến thức của AI, lại kèm con số cụ thể. Tra trên website ngân hàng.',
        flags: ['recent', 'number'],
      },
      {
        id: 'savings-amount',
        text: 'Với thu nhập của bạn, mỗi tháng gửi 10 triệu là vừa sức.',
        accepted: ['insufficient'],
        explain: 'Bạn chưa nói thu nhập hay chi tiêu. Con số này AI tự nghĩ ra.',
        flags: ['number'],
      },
      {
        id: 'savings-tax',
        text: 'Theo luật mới, tiền lãi tiết kiệm của bạn sẽ bị đánh thuế 5% từ năm sau, nên rút ra mua vàng ngay.',
        accepted: ['expert', 'needs_lookup'],
        explain: 'Quy định thuế và quyết định đầu tư cần nguồn chính thức hoặc chuyên gia tài chính. Đừng làm theo ngay.',
        flags: ['recent', 'number'],
      },
    ],
  },
];

export const ALL_CLAIMS: Claim[] = DETECTIVE_CASES.flatMap((c) => c.claims);
