"use client";

import Image from "next/image";
import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";

type Conversation = { question: string; answer: string };
type IconName = "arrow" | "clock" | "plus" | "close" | "mic" | "send" | "speaker" | "document" | "chevron" | "info";

const suggestions = ["한글은 왜 만들었나요?", "백성을 위해 어떤 일을 했나요?", "장영실은 어떤 사람인가요?"];
const answers: Record<string, string> = {
  "한글은 왜 만들었나요?": "백성들이 자신의 생각을 글로 쉽게 표현할 수 있기를 바랐단다. 그래서 누구나 배우기 쉬운 새 글자를 만들었지.",
  "백성을 위해 어떤 일을 했나요?": "백성의 생활에 도움이 되는 일을 중요하게 여겼단다. 농사와 글자, 과학처럼 삶과 가까운 문제를 살피려 노력했지.",
  "장영실은 어떤 사람인가요?": "장영실은 조선의 과학 기술 발전에 힘쓴 인물이란다. 시간을 재고 날씨를 살피는 여러 기구를 만드는 데 참여했지.",
};
const welcome = "만나서 반갑구나. 내게 궁금한 것이 있느냐? 한글부터 조선의 일상까지, 함께 이야기해 보자꾸나.";

export function ChatExperience() {
  const [started, setStarted] = useState(false);
  const [question, setQuestion] = useState("");
  const [sentQuestion, setSentQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [autoListen, setAutoListen] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<Conversation[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function ask(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || loading) return;
    setLoading(true);
    setSentQuestion(text);
    setSourceOpen(false);
    setNotice("");
    timer.current = setTimeout(() => {
      const nextAnswer = answers[text] ?? "좋은 질문이구나. 실제 서비스에서는 검토된 역사 자료를 바탕으로 질문에 맞는 답변이 이곳에 나타난단다.";
      setHistory((items) => [...items, { question: text, answer: nextAnswer }]);
      setSentQuestion("");
      setQuestion("");
      setLoading(false);
      if (autoListen) setNotice("답변 듣기는 준비 중이에요. 지금은 글로 답변을 확인해 주세요.");
      timer.current = null;
    }, 850);
  }

  function reset() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setQuestion(""); setSentQuestion("");
    setHistory([]); setLoading(false); setSourceOpen(false);
    setResetOpen(false); setNotice("");
  }

  function selectQuestion(text: string) {
    setQuestion(text);
    input.current?.focus();
  }

  const header = <header className="site-header">
    <button className="brand" aria-label="세종톡 소개 화면" onClick={() => setStarted(false)}>
      <Image src="/images/logo-sejongtalk.png" alt="세종톡" width={1928} height={815} sizes="140px" preload />
    </button>
    <nav aria-label="대화 설정">
      <label className="auto-listen"><input type="checkbox" role="switch" checked={autoListen} onChange={(event) => setAutoListen(event.target.checked)} /><span className="switch-track" aria-hidden="true" /><span>자동 듣기</span></label>
      {started && <><span className="nav-divider" /><button className="outline-button history-trigger" onClick={() => setHistoryOpen(true)}><Icon name="clock" /><span>이전 대화</span><Icon name="chevron" /></button><button className="primary-button new-chat" onClick={() => setResetOpen(true)}><Icon name="plus" /><span>새 대화</span></button></>}
    </nav>
  </header>;

  if (!started) return <main className="sejong-app intro-page">
    {header}
    <section className="intro-hero">
      <Scene intro />
      <div className="intro-copy">
        <p className="eyebrow"><ChatIcon />역사 속 인물과 나누는 대화</p>
        <h1>세종대왕과<br /><em>이야기</em>해 볼까요?</h1>
        <p className="intro-description">한글부터 옛날 생활까지,<br />궁금한 것을 글로 쓰거나 말로 물어보세요.</p>
        <button className="primary-button start-button" onClick={() => setStarted(true)}>세종대왕 만나기 <Icon name="arrow" /></button>
        <p className="ai-notice">역사 자료를 바탕으로 재구성한 AI예요.<br />실제 세종대왕이 남긴 말과는 다를 수 있어요.</p>
      </div>
    </section>
    <section className="how-to" aria-labelledby="how-to-title">
      <div className="how-to-heading"><span>우리들의 역사교실</span><h2 id="how-to-title">이렇게 이야기해요</h2></div>
      <ol><li><b>1</b><div><strong>궁금한 것을 물어요</strong><p>추천 질문을 고르거나 직접 작성해요.</p></div></li><li><b>2</b><div><strong>답변과 출처를 살펴요</strong><p>쉬운 설명으로 역사를 알아가요.</p></div></li><li><b>3</b><div><strong>이야기를 이어가요</strong><p>더 궁금해진 것을 자유롭게 물어봐요.</p></div></li></ol>
    </section>
  </main>;

  return <main className="sejong-app chat-page">
    {header}
    <section className="chat-workspace">
      <Scene />
      <div className="conversation-panel">
        <section className="conversation-card" aria-labelledby="conversation-title">
          <div className="conversation-heading"><h1 id="conversation-title"><ChatIcon />세종대왕과 이야기하기</h1><span className="sample-badge">예시 대화</span></div>
          <div className="dialogue">
            <div className="message sejong-message"><Avatar /><div className="answer-content">
              <strong className="speaker-name">세종대왕</strong>
              <div className="answer-bubble"><p>{welcome}</p></div>
            </div></div>
            {history.map((item, index) => <div className="conversation-turn" key={`${item.question}-${index}`}>
              <div className="message student-message"><div><span className="sr-only">나의 질문</span><p>{item.question}</p></div><Avatar student /></div>
              <div className="message sejong-message"><Avatar /><div className="answer-content">
                <strong className="speaker-name">세종대왕</strong>
                <div className="answer-bubble"><p>{item.answer}</p></div>
                {index === history.length - 1 && !loading && <>
                <div className="answer-actions"><button className="primary-button listen-button" onClick={() => setNotice("답변 듣기는 준비 중이에요. 지금은 글로 답변을 확인해 주세요.")}><Icon name="speaker" />답변 듣기</button><div className="speed-control"><span id="speed-label">재생 속도</span><div role="group" aria-labelledby="speed-label">{[0.8, 1, 1.2].map((value) => <button key={value} aria-pressed={speed === value} onClick={() => setSpeed(value)}>{value}배</button>)}</div></div></div>
                <div className="source-card"><button className="source-toggle" aria-expanded={sourceOpen} aria-controls="answer-sources" onClick={() => setSourceOpen(!sourceOpen)}><Icon name="document" /><span>이 이야기의 출처 보기</span><Icon name="chevron" /></button>{sourceOpen && <div id="answer-sources"><p>현재 답변은 화면 확인용 예시예요. 실제 답변이 연결되면 검토된 역사 자료와 원문 링크가 이곳에 표시돼요.</p></div>}</div>
                </>}
              </div></div>
            </div>)}
            {loading && <div className="conversation-turn pending-turn">
              <div className="message student-message"><div><span className="sr-only">나의 질문</span><p>{sentQuestion}</p></div><Avatar student /></div>
              <div className="message sejong-message"><Avatar /><div className="answer-content">
                <strong className="speaker-name">세종대왕</strong>
                <div className="answer-bubble" role="status" aria-live="polite" aria-atomic="true"><p>잠시만 기다려 주겠느냐?<br />답변을 준비하고 있단다.</p><span className="typing-dots" aria-label="답변 준비 중"><i /><i /><i /></span></div>
              </div></div>
            </div>}
          </div>
          {notice && <div className="service-notice" role="status"><Icon name="info" /><p>{notice}</p><button aria-label="안내 닫기" onClick={() => setNotice("")}><Icon name="close" /></button></div>}
        </section>
        <section className="question-area" aria-label="질문 작성">
          <h2>이런 질문은 어때요?</h2>
          <div className="suggestions">{suggestions.map((item) => <button key={item} disabled={loading} onClick={() => selectQuestion(item)}>{item}</button>)}</div>
          <form className="composer" onSubmit={ask}>
            <div className="composer-label"><label htmlFor="question">이어서 궁금한 점을 물어보세요</label><small>{question.length} / 500</small></div>
            <div className="composer-controls"><textarea ref={input} id="question" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={500} rows={2} placeholder="세종대왕에게 궁금한 것을 물어보세요." disabled={loading} /><button type="button" className="outline-button mic-button" disabled={loading} onClick={() => setNotice("음성 질문은 준비 중이에요. 지금은 질문을 글로 입력해 주세요.")}><Icon name="mic" /><span>말로 질문</span></button><button className="primary-button send-button" disabled={!question.trim() || loading}><Icon name="send" /><span>{loading ? "답변 준비 중" : "질문 보내기"}</span></button></div>
          </form>
        </section>
        <p className="chat-footer">역사 자료를 바탕으로 재구성한 AI예요. 실제 세종대왕이 남긴 말과는 다를 수 있어요.</p>
      </div>
    </section>
    {historyOpen && <Overlay titleId="history-title" className="history-drawer" onClose={() => setHistoryOpen(false)}>
      <header><h2 id="history-title">이전 대화</h2><button className="outline-button" onClick={() => setHistoryOpen(false)}><Icon name="close" />닫기</button></header><p className="drawer-description">지금 대화에서 나눈 이야기예요.</p>
      {history.length === 0 ? <div className="empty-history"><ChatIcon /><strong>아직 대화가 없어요</strong><p>세종대왕에게 첫 질문을 건네 보세요.</p></div> : <div className="history-list">{history.map((item, index) => <article key={index}><div className="history-message"><Avatar student /><div><strong>나</strong><p>{item.question}</p></div></div><div className="history-message"><Avatar /><div><strong>세종대왕</strong><p>{item.answer}</p></div></div></article>)}</div>}
    </Overlay>}
    {resetOpen && <Overlay titleId="reset-title" className="reset-modal" onClose={() => setResetOpen(false)}><h2 id="reset-title">지금 대화를 지우고<br />처음부터 시작할까요?</h2><p>지금까지의 질문과 답변이 모두 사라져요.<br />진행 중인 답변도 멈춰요.</p><div className="modal-actions"><button className="outline-button" onClick={() => setResetOpen(false)}>계속 대화하기</button><button className="primary-button" onClick={reset}>새로 시작하기</button></div></Overlay>}
  </main>;
}

function Scene({ intro = false }: { intro?: boolean }) {
  return <div className={`scene ${intro ? "intro-scene" : "chat-scene"}`}><Image src={`/images/scene-${intro ? "intro" : "chat"}.png`} alt="궁궐 앞에서 책을 들고 반갑게 인사하는 세종대왕" fill sizes={intro ? "(max-width: 760px) 100vw, 47vw" : "(max-width: 760px) 100vw, 28vw"} preload /><span className="scene-badge">AI로 재구성한 세종대왕</span></div>;
}

function ChatIcon() { return <Image className="chat-icon" src="/images/icon-chat.png" alt="" width={36} height={36} />; }
function Avatar({ student = false }: { student?: boolean }) { return <Image className="avatar" src={`/images/avatar-${student ? "student" : "sejong"}.png`} alt="" width={48} height={48} />; }

// Native dialog supplies focus trapping, Escape dismissal, and modal semantics.
function Overlay({ children, titleId, className, onClose }: { children: ReactNode; titleId: string; className: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    element?.showModal();
    document.body.style.overflow = "hidden";
    return () => { element?.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className={className} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose(); } }}>{children}</dialog>;
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    mic: <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></>,
    send: <path d="m21 3-7 18-4-7-7-4 18-7ZM10 14 21 3" />,
    speaker: <><path d="M11 4 5 9H2v6h3l6 5V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>,
    document: <><path d="M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8m-8 4h8" /></>,
    chevron: <path d="m6 9 6 6 6-6" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></>,
  };
  return <svg className="line-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
