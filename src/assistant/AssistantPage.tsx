import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMerchant } from "../dashboard/MerchantContext";
import { api, ApiError } from "../lib/api";
import type { ChatLink } from "../lib/api";
import { IconRobot, IconSend, IconChevron } from "../components/icons";

// Functional 10 — "Trợ lý SoHo". A read-only, grounded chat assistant over the
// merchant's OWN data. It only answers + points to in-app screens (source cards /
// "Làm tiếp" deep-links); it never performs an action. The server builds the FACTS
// pack, gates every number, and falls back to a deterministic answer when the AI
// is off/slow — so this page is always useful.

interface Msg {
  role: "user" | "assistant";
  content: string;
  sources?: ChatLink[];
  actions?: ChatLink[];
  mode?: "ai" | "fallback";
  error?: boolean;
}

const STARTERS = [
  "Hôm nay bán được bao nhiêu?",
  "Món nào sắp hết hàng?",
  "Tuần này so với tuần trước thế nào?",
  "Có việc gì cần xử lý không?",
];

function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "OFFLINE") return "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.";
    if (e.code === "UNAUTHORIZED") return "Phiên đăng nhập đã hết. Hãy đăng nhập lại.";
    if (e.code === "FORBIDDEN") return "Bạn không có quyền xem dữ liệu cửa hàng này.";
    if (e.status === 503) return "Máy chủ đang bận. Vui lòng thử lại.";
  }
  return "Có lỗi khi trả lời. Vui lòng thử lại.";
}

export function AssistantPage() {
  const nav = useNavigate();
  const { merchant } = useMerchant();
  const merchantId = merchant?.id ?? null;

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // A new merchant context invalidates the old conversation (spec 2.2): never
  // reuse another store's turns.
  useEffect(() => {
    setMessages([]);
  }, [merchantId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  async function ask(history: Msg[]) {
    if (!merchantId) return;
    setPending(true);
    try {
      const payload = history.slice(-10).map((m) => ({ role: m.role, content: m.content }));
      const res = await api.chat(merchantId, payload);
      setMessages([
        ...history,
        { role: "assistant", content: res.reply, sources: res.sources, actions: res.actions, mode: res.mode },
      ]);
    } catch (e) {
      setMessages([...history, { role: "assistant", content: friendlyError(e), error: true }]);
    } finally {
      setPending(false);
    }
  }

  function sendText(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending || !merchantId) return;
    const history = [...messages, { role: "user", content: trimmed } as Msg];
    setMessages(history);
    setInput("");
    void ask(history);
  }

  function retry() {
    if (pending) return;
    // Drop the trailing error bubble, keep the user turn, re-ask.
    const history = messages.filter((m, i) => !(i === messages.length - 1 && m.error));
    setMessages(history);
    void ask(history);
  }

  const empty = messages.length === 0;

  return (
    <div className="screen screen--tabbed chat">
      <header className="chat__head">
        <div className="chat__head-ic">
          <IconRobot size={22} />
        </div>
        <div className="chat__head-txt">
          <div className="chat__head-title">Trợ lý SoHo</div>
          <div className="chat__head-sub">{merchant?.display_name ?? "Cửa hàng của bạn"}</div>
        </div>
      </header>

      <div className="chat__scroll" ref={scrollRef}>
        {empty && (
          <div className="chat__intro">
            <div className="chat__intro-ic">
              <IconRobot size={30} />
            </div>
            <div className="chat__intro-t">Hỏi tôi về cửa hàng của bạn</div>
            <div className="chat__intro-d">
              Tôi trả lời bằng số liệu thật của cửa hàng và chỉ bạn tới đúng màn hình để xem chi tiết.
              Tôi chỉ trả lời và chỉ đường — không tự thực hiện thao tác.
            </div>
            <div className="chat__starters">
              {STARTERS.map((q) => (
                <button key={q} className="chat__starter" onClick={() => sendText(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`chat__row chat__row--${m.role}`}>
            <div className={`chat__bubble chat__bubble--${m.role} ${m.error ? "chat__bubble--error" : ""}`}>
              {m.content}
            </div>

            {m.role === "assistant" && !!m.sources?.length && (
              <div className="chat__srcs">
                <span className="chat__srcs-lb">Nguồn</span>
                {m.sources.map((s) => (
                  <button key={s.key} className="chat__src" onClick={() => nav(s.route)}>
                    {s.label}
                  </button>
                ))}
              </div>
            )}

            {m.role === "assistant" && !!m.actions?.length && (
              <div className="chat__acts">
                {m.actions.map((a) => (
                  <button key={a.key} className="chat__act" onClick={() => nav(a.route)}>
                    {a.label}
                    <IconChevron size={15} />
                  </button>
                ))}
              </div>
            )}

            {m.role === "assistant" && m.error && (
              <button className="chat__retry" onClick={retry}>
                Thử lại
              </button>
            )}
          </div>
        ))}

        {pending && (
          <div className="chat__row chat__row--assistant">
            <div className="chat__bubble chat__bubble--assistant chat__typing" aria-label="Đang trả lời">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      <form
        className="chat__composer"
        onSubmit={(e) => {
          e.preventDefault();
          sendText(input);
        }}
      >
        <input
          className="chat__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Hỏi về doanh thu, tồn kho…"
          enterKeyHint="send"
          aria-label="Nhập câu hỏi"
          disabled={!merchantId}
        />
        <button
          className="chat__sendbtn"
          type="submit"
          disabled={!input.trim() || pending || !merchantId}
          aria-label="Gửi"
        >
          <IconSend size={20} />
        </button>
      </form>
    </div>
  );
}
