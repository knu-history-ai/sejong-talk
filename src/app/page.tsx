export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <p className="mb-4 text-sm font-semibold tracking-widest text-slate-500">SEJONG TALK</p>
      <h1 className="text-4xl font-bold tracking-tight">세종톡</h1>
      <p className="mt-5 text-xl leading-relaxed">세종과 글과 음성으로 대화하는 교육용 웹 서비스</p>
      <section className="mt-10 rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">공통 개발 환경</h2>
        <p className="mt-3 leading-7 text-slate-600">프로젝트 초기 설정을 완료했습니다. 대화 화면과 AI·음성 기능은 팀에서 순차적으로 구현합니다.</p>
      </section>
    </main>
  );
}
