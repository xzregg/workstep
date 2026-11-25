import type { Lang } from './index'

interface HomepageFaqCopy {
  title: string
  items: [question: string, answer: string][]
}

export const homepageFaqCopy: Record<Lang, HomepageFaqCopy> = {
  'zh-CN': {
    title: '开始之前，你可能想知道。',
    items: [
      ['我不会画流程，也可以开始吗？', '可以从流程模板开始，或用对话拟定流程，再在画布确认步骤、输入输出和审核点。你仍需明确目标，核对流程是否适合任务。'],
      ['什么时候值得用流程？', '适合重复执行、有明确交付要求，或需要多种技能接力的工作。简单的一次性问答可以直接通过对话完成。'],
      ['它怎样判断工作完成了？', '流程按输出要求与审核规则推进。文件存在、自动审核通过，不等于满足业务要求；重要结果仍需验证依据和人工判断。'],
      ['我的材料保存在哪里？', '项目与执行记录保存在你的设备或自管环境。调用外部模型时，相关上下文按所选引擎配置发送给对应服务。'],
    ],
  },
  'zh-TW': {
    title: '開始之前，你可能想知道。',
    items: [
      ['我不會畫流程，也可以開始嗎？', '可以從流程範本開始，或用對話擬定流程，再於畫布確認步驟、輸入輸出和審核點。你仍需明確目標，核對流程是否適合任務。'],
      ['什麼時候值得用流程？', '適合重複執行、有明確交付要求，或需要多種技能接力的工作。簡單的一次性問答可以直接透過對話完成。'],
      ['它怎樣判斷工作完成了？', '流程依輸出要求與審核規則推進。檔案存在、自動審核通過，不等於滿足業務要求；重要結果仍需驗證依據和人工判斷。'],
      ['我的材料儲存在哪裡？', '專案與執行記錄儲存在你的裝置或自管環境。呼叫外部模型時，相關上下文依所選引擎設定傳送給對應服務。'],
    ],
  },
  'en-US': {
    title: 'Before you begin.',
    items: [
      ['Can I start without knowing how to design a workflow?', 'Start with a template or draft a workflow in chat, then confirm its steps, inputs, outputs and review points on the canvas. You still need to define the goal and check that the workflow fits the task.'],
      ['When is a workflow useful?', 'For repeatable work, clear deliverables or tasks that need several skills working in sequence. Simple, one-off questions can be handled directly in chat.'],
      ['How does it decide the work is done?', 'The workflow follows its output requirements and review rules. A file existing or an automated review passing does not prove business requirements are met. Important results still need evidence and human judgment.'],
      ['Where are my materials stored?', 'Projects and execution records stay on your device or self-managed environment. When using external models, relevant context is sent to the corresponding service according to the selected engine configuration.'],
    ],
  },
  'ja-JP': {
    title: '始める前に知っておきたいこと。',
    items: [
      ['フローの設計ができなくても始められますか？', 'テンプレートから始めるか、チャットでフローを作成し、キャンバスで手順、入出力、レビュー箇所を確認できます。目標を明確にし、タスクに合うフローか確認する必要はあります。'],
      ['どのような仕事にフローが役立ちますか？', '繰り返す仕事、成果物の要件が明確な仕事、複数のスキルを引き継ぐ仕事に適しています。単発の簡単な質問はチャットで直接扱えます。'],
      ['仕事の完了はどう判断しますか？', '出力要件とレビュー規則に従って進みます。ファイルの存在や自動レビューの合格だけでは業務要件を満たした証明にはなりません。重要な結果には検証の根拠と人の判断が必要です。'],
      ['資料はどこに保存されますか？', 'プロジェクトと実行記録は自分の端末または自己管理環境に保存されます。外部モデルを使う場合、選択したエンジンの設定に従って関連するコンテキストが対応サービスに送信されます。'],
    ],
  },
  'ko-KR': {
    title: '시작하기 전에 알아두세요.',
    items: [
      ['워크플로를 설계할 줄 몰라도 시작할 수 있나요?', '템플릿으로 시작하거나 대화로 워크플로 초안을 만든 뒤 캔버스에서 단계, 입력, 출력과 검토 지점을 확인할 수 있습니다. 목표를 정하고 작업에 맞는 흐름인지 확인해야 합니다.'],
      ['어떤 작업에 워크플로가 유용한가요?', '반복하는 작업, 산출물 요구 사항이 명확한 작업, 여러 기술을 순서대로 활용하는 작업에 적합합니다. 간단한 일회성 질문은 대화에서 바로 처리할 수 있습니다.'],
      ['작업 완료는 어떻게 판단하나요?', '출력 요구 사항과 검토 규칙에 따라 진행합니다. 파일이 있거나 자동 검토를 통과했다고 업무 요구 사항을 충족한 것은 아닙니다. 중요한 결과에는 검증 근거와 사람의 판단이 필요합니다.'],
      ['자료는 어디에 저장되나요?', '프로젝트와 실행 기록은 기기 또는 직접 관리하는 환경에 저장됩니다. 외부 모델을 사용하면 선택한 엔진 설정에 따라 관련 맥락이 해당 서비스로 전송됩니다.'],
    ],
  },
  'fr-FR': {
    title: 'Avant de commencer.',
    items: [
      ['Puis-je commencer sans savoir concevoir un workflow ?', 'Partez d’un modèle ou préparez le workflow par discussion, puis vérifiez les étapes, entrées, sorties et points de contrôle sur le canevas. Définissez votre objectif et vérifiez que le workflow convient à la tâche.'],
      ['Quand un workflow est-il utile ?', 'Pour un travail répétitif, des livrables précis ou plusieurs compétences à enchaîner. Une question simple et ponctuelle peut être traitée directement dans la discussion.'],
      ['Comment le travail est-il déclaré terminé ?', 'Le workflow suit ses exigences de sortie et ses règles de contrôle. Un fichier présent ou un contrôle automatique réussi ne prouve pas que les exigences métier sont satisfaites. Les résultats importants nécessitent des preuves et un jugement humain.'],
      ['Où mes documents sont-ils stockés ?', 'Les projets et journaux d’exécution restent sur votre appareil ou dans votre environnement autogéré. Avec un modèle externe, le contexte pertinent est envoyé au service correspondant selon la configuration du moteur choisi.'],
    ],
  },
  'de-DE': {
    title: 'Bevor Sie beginnen.',
    items: [
      ['Kann ich ohne Kenntnisse im Workflow-Design beginnen?', 'Nutzen Sie eine Vorlage oder entwerfen Sie den Ablauf im Chat. Prüfen Sie dann Schritte, Ein- und Ausgaben sowie Prüfpunkte auf der Arbeitsfläche. Ziel und Eignung für die Aufgabe müssen Sie weiterhin festlegen und prüfen.'],
      ['Wann lohnt sich ein Workflow?', 'Bei wiederkehrender Arbeit, klaren Ergebnisanforderungen oder Aufgaben mit mehreren aufeinanderfolgenden Fähigkeiten. Einfache einmalige Fragen lassen sich direkt im Chat bearbeiten.'],
      ['Wie wird entschieden, ob die Arbeit fertig ist?', 'Der Ablauf folgt Ausgabeanforderungen und Prüfregeln. Eine vorhandene Datei oder bestandene automatische Prüfung belegt noch nicht, dass fachliche Anforderungen erfüllt sind. Wichtige Ergebnisse brauchen Nachweise und menschliches Urteil.'],
      ['Wo werden meine Materialien gespeichert?', 'Projekte und Ausführungsprotokolle bleiben auf Ihrem Gerät oder in Ihrer selbst verwalteten Umgebung. Bei externen Modellen wird relevanter Kontext gemäß der gewählten Engine-Konfiguration an den entsprechenden Dienst gesendet.'],
    ],
  },
  'it-IT': {
    title: 'Prima di iniziare.',
    items: [
      ['Posso iniziare senza saper progettare un flusso?', 'Parti da un modello o prepara il flusso in chat, poi verifica passaggi, input, output e punti di revisione sul canvas. Devi comunque definire l’obiettivo e verificare che il flusso sia adatto al compito.'],
      ['Quando è utile un flusso di lavoro?', 'Per attività ripetute, risultati ben definiti o compiti che richiedono più competenze in sequenza. Le domande semplici e occasionali si possono gestire direttamente in chat.'],
      ['Come stabilisce che il lavoro è finito?', 'Il flusso segue requisiti di output e regole di revisione. Un file presente o una verifica automatica superata non dimostrano che i requisiti operativi siano soddisfatti. I risultati importanti richiedono prove e giudizio umano.'],
      ['Dove vengono conservati i miei materiali?', 'Progetti e registri di esecuzione restano sul tuo dispositivo o nel tuo ambiente autogestito. Con modelli esterni, il contesto pertinente viene inviato al servizio corrispondente secondo la configurazione del motore scelto.'],
    ],
  },
  'es-ES': {
    title: 'Antes de empezar.',
    items: [
      ['¿Puedo empezar sin saber diseñar un flujo?', 'Parte de una plantilla o prepara el flujo en el chat y confirma pasos, entradas, salidas y puntos de revisión en el lienzo. Debes definir el objetivo y comprobar que el flujo se ajusta a la tarea.'],
      ['¿Cuándo resulta útil un flujo?', 'Para trabajo repetitivo, entregables claros o tareas que requieren varias habilidades en secuencia. Las preguntas sencillas y puntuales se pueden resolver directamente en el chat.'],
      ['¿Cómo decide que el trabajo está terminado?', 'El flujo sigue los requisitos de salida y las reglas de revisión. Que exista un archivo o se apruebe una revisión automática no demuestra que se cumplan los requisitos del trabajo. Los resultados importantes necesitan pruebas y criterio humano.'],
      ['¿Dónde se guardan mis materiales?', 'Los proyectos y registros de ejecución permanecen en tu dispositivo o entorno autogestionado. Al usar modelos externos, el contexto pertinente se envía al servicio correspondiente según la configuración del motor elegido.'],
    ],
  },
  'pt-BR': {
    title: 'Antes de começar.',
    items: [
      ['Posso começar sem saber criar um fluxo?', 'Use um modelo ou prepare o fluxo na conversa e confirme etapas, entradas, saídas e pontos de revisão no canvas. Você ainda precisa definir o objetivo e verificar se o fluxo é adequado à tarefa.'],
      ['Quando um fluxo é útil?', 'Para trabalho repetitivo, entregas bem definidas ou tarefas com várias habilidades em sequência. Perguntas simples e pontuais podem ser tratadas diretamente na conversa.'],
      ['Como ele decide que o trabalho terminou?', 'O fluxo segue requisitos de saída e regras de revisão. Um arquivo existir ou passar por revisão automática não comprova o atendimento aos requisitos do trabalho. Resultados importantes exigem evidências e julgamento humano.'],
      ['Onde meus materiais são armazenados?', 'Projetos e registros de execução ficam no seu dispositivo ou ambiente autogerenciado. Ao usar modelos externos, o contexto relevante é enviado ao serviço correspondente conforme a configuração do mecanismo escolhido.'],
    ],
  },
  'nl-NL': {
    title: 'Voordat je begint.',
    items: [
      ['Kan ik beginnen zonder workflows te kunnen ontwerpen?', 'Begin met een sjabloon of maak een opzet in de chat. Controleer daarna stappen, invoer, uitvoer en beoordelingspunten op het canvas. Bepaal zelf het doel en of de workflow bij de taak past.'],
      ['Wanneer is een workflow nuttig?', 'Bij herhaalbaar werk, duidelijke oplevereisen of taken die meerdere vaardigheden achtereen nodig hebben. Eenvoudige eenmalige vragen kun je direct in de chat behandelen.'],
      ['Hoe wordt bepaald of het werk af is?', 'De workflow volgt uitvoereisen en beoordelingsregels. Een bestaand bestand of een geslaagde automatische controle bewijst niet dat aan de werkeisen is voldaan. Belangrijke resultaten vragen om bewijs en menselijk oordeel.'],
      ['Waar worden mijn materialen opgeslagen?', 'Projecten en uitvoeringslogboeken blijven op je apparaat of in je zelfbeheerde omgeving. Bij externe modellen wordt relevante context naar de betreffende dienst verzonden volgens de gekozen engineconfiguratie.'],
    ],
  },
  'ru-RU': {
    title: 'Перед началом работы.',
    items: [
      ['Можно начать, не умея проектировать процессы?', 'Возьмите шаблон или составьте процесс в чате, затем проверьте шаги, входы, выходы и точки проверки на холсте. Цель и соответствие процесса задаче по-прежнему определяете вы.'],
      ['Когда полезен рабочий процесс?', 'Для повторяющейся работы, чётких требований к результату или задач, где последовательно нужны разные навыки. Простые разовые вопросы можно решать прямо в чате.'],
      ['Как определяется завершение работы?', 'Процесс следует требованиям к выходным данным и правилам проверки. Наличие файла или успешная автоматическая проверка не доказывают выполнение деловых требований. Важные результаты требуют подтверждений и человеческой оценки.'],
      ['Где хранятся мои материалы?', 'Проекты и журналы выполнения остаются на вашем устройстве или в управляемой вами среде. При работе с внешними моделями нужный контекст отправляется соответствующему сервису согласно настройкам выбранного движка.'],
    ],
  },
  'pl-PL': {
    title: 'Zanim zaczniesz.',
    items: [
      ['Czy mogę zacząć bez umiejętności projektowania przepływów?', 'Skorzystaj z szablonu lub przygotuj przepływ w rozmowie, a następnie sprawdź kroki, wejścia, wyjścia i punkty kontroli na płótnie. Nadal musisz określić cel i dopasowanie przepływu do zadania.'],
      ['Kiedy przepływ pracy jest przydatny?', 'Przy powtarzalnej pracy, jasnych wymaganiach dotyczących rezultatów lub zadaniach wymagających kolejno różnych umiejętności. Proste jednorazowe pytania można obsłużyć bezpośrednio w rozmowie.'],
      ['Jak ustala, że praca jest zakończona?', 'Przepływ stosuje wymagania wyjścia i reguły kontroli. Istnienie pliku lub pozytywna kontrola automatyczna nie dowodzą spełnienia wymagań biznesowych. Ważne wyniki wymagają dowodów i oceny człowieka.'],
      ['Gdzie są przechowywane moje materiały?', 'Projekty i dzienniki wykonania pozostają na Twoim urządzeniu lub we własnym środowisku. Przy modelach zewnętrznych odpowiedni kontekst jest przesyłany do właściwej usługi zgodnie z konfiguracją wybranego silnika.'],
    ],
  },
  'tr-TR': {
    title: 'Başlamadan önce.',
    items: [
      ['İş akışı tasarlamayı bilmeden başlayabilir miyim?', 'Bir şablonla başlayın veya sohbetle akış taslağı oluşturun; ardından adımları, girdileri, çıktıları ve inceleme noktalarını tuvalde doğrulayın. Hedefi belirlemeniz ve akışın işe uygunluğunu kontrol etmeniz gerekir.'],
      ['İş akışı ne zaman yararlıdır?', 'Tekrarlanan işler, açık teslim gereksinimleri veya farklı becerilerin sırayla gerektiği görevler için uygundur. Basit, tek seferlik sorular doğrudan sohbette ele alınabilir.'],
      ['İşin bittiğine nasıl karar verir?', 'Akış, çıktı gereksinimlerine ve inceleme kurallarına göre ilerler. Dosyanın bulunması veya otomatik incelemenin geçmesi iş gereksinimlerinin karşılandığını kanıtlamaz. Önemli sonuçlar kanıt ve insan değerlendirmesi gerektirir.'],
      ['Materyallerim nerede saklanır?', 'Projeler ve yürütme kayıtları cihazınızda veya kendi yönettiğiniz ortamda kalır. Harici modeller kullanıldığında ilgili bağlam, seçilen motorun yapılandırmasına göre ilgili hizmete gönderilir.'],
    ],
  },
  'vi-VN': {
    title: 'Trước khi bắt đầu.',
    items: [
      ['Tôi không biết thiết kế quy trình thì có bắt đầu được không?', 'Bạn có thể dùng mẫu hoặc phác thảo quy trình qua trò chuyện, rồi xác nhận các bước, đầu vào, đầu ra và điểm kiểm tra trên canvas. Bạn vẫn cần xác định mục tiêu và kiểm tra quy trình có phù hợp với việc cần làm không.'],
      ['Khi nào nên dùng quy trình?', 'Phù hợp với công việc lặp lại, có yêu cầu bàn giao rõ ràng hoặc cần nhiều kỹ năng nối tiếp nhau. Câu hỏi đơn giản, chỉ dùng một lần có thể xử lý trực tiếp trong trò chuyện.'],
      ['Làm sao biết công việc đã hoàn thành?', 'Quy trình tiến theo yêu cầu đầu ra và quy tắc kiểm tra. Có tệp hoặc vượt qua kiểm tra tự động không chứng minh đã đáp ứng yêu cầu nghiệp vụ. Kết quả quan trọng vẫn cần bằng chứng và đánh giá của con người.'],
      ['Tài liệu của tôi được lưu ở đâu?', 'Dự án và nhật ký thực thi được lưu trên thiết bị hoặc môi trường bạn tự quản lý. Khi dùng mô hình bên ngoài, ngữ cảnh liên quan được gửi đến dịch vụ tương ứng theo cấu hình engine đã chọn.'],
    ],
  },
  'id-ID': {
    title: 'Sebelum memulai.',
    items: [
      ['Bisakah saya mulai tanpa tahu cara merancang alur kerja?', 'Mulai dari templat atau susun alur melalui percakapan, lalu pastikan langkah, masukan, keluaran dan titik peninjauan di kanvas. Anda tetap perlu menetapkan tujuan dan memeriksa kesesuaian alur dengan tugas.'],
      ['Kapan alur kerja berguna?', 'Untuk pekerjaan berulang, hasil yang ditentukan dengan jelas, atau tugas yang memerlukan beberapa keterampilan secara berurutan. Pertanyaan sederhana sekali pakai dapat ditangani langsung di percakapan.'],
      ['Bagaimana pekerjaan dinyatakan selesai?', 'Alur mengikuti persyaratan keluaran dan aturan peninjauan. Adanya berkas atau lolosnya pemeriksaan otomatis tidak membuktikan bahwa kebutuhan bisnis terpenuhi. Hasil penting tetap memerlukan bukti dan penilaian manusia.'],
      ['Di mana materi saya disimpan?', 'Proyek dan catatan eksekusi tetap berada di perangkat atau lingkungan yang Anda kelola sendiri. Saat memakai model eksternal, konteks terkait dikirim ke layanan yang sesuai menurut konfigurasi mesin yang dipilih.'],
    ],
  },
  'th-TH': {
    title: 'สิ่งที่ควรรู้ก่อนเริ่มต้น',
    items: [
      ['เริ่มได้ไหมถ้าออกแบบเวิร์กโฟลว์ไม่เป็น?', 'เริ่มจากเทมเพลตหรือร่างผ่านแชต แล้วตรวจสอบขั้นตอน ข้อมูลเข้า ผลลัพธ์ และจุดตรวจทานบนแคนวาส คุณยังต้องกำหนดเป้าหมายและตรวจว่าเวิร์กโฟลว์เหมาะกับงานหรือไม่'],
      ['เวิร์กโฟลว์เหมาะกับงานแบบไหน?', 'เหมาะกับงานที่ทำซ้ำ มีข้อกำหนดผลงานชัดเจน หรือต้องใช้หลายทักษะต่อกัน คำถามง่าย ๆ ที่ถามครั้งเดียวจัดการในแชตได้โดยตรง'],
      ['ระบบตัดสินอย่างไรว่างานเสร็จแล้ว?', 'เวิร์กโฟลว์ดำเนินตามข้อกำหนดผลลัพธ์และกฎตรวจทาน การมีไฟล์หรือผ่านการตรวจอัตโนมัติไม่ได้ยืนยันว่าตรงตามความต้องการทางธุรกิจ ผลลัพธ์สำคัญยังต้องมีหลักฐานและการพิจารณาของคน'],
      ['ข้อมูลของฉันเก็บไว้ที่ไหน?', 'โปรเจกต์และบันทึกการทำงานเก็บในอุปกรณ์หรือสภาพแวดล้อมที่คุณดูแลเอง เมื่อใช้โมเดลภายนอก บริบทที่เกี่ยวข้องจะส่งไปยังบริการนั้นตามการตั้งค่าเอนจินที่เลือก'],
    ],
  },
  'hi-IN': {
    title: 'शुरू करने से पहले।',
    items: [
      ['क्या वर्कफ़्लो बनाना जाने बिना शुरू कर सकता हूँ?', 'टेम्पलेट से शुरू करें या चैट में रूपरेखा बनाएँ, फिर कैनवास पर चरण, इनपुट, आउटपुट और समीक्षा बिंदु जाँचें। लक्ष्य तय करना और प्रक्रिया का काम के अनुकूल होना जाँचना अभी भी आपकी ज़िम्मेदारी है।'],
      ['वर्कफ़्लो कब उपयोगी है?', 'बार-बार किए जाने वाले काम, स्पष्ट परिणामों या क्रम से कई कौशल माँगने वाले कार्यों के लिए। सरल, एक बार के प्रश्न सीधे चैट में हल किए जा सकते हैं।'],
      ['काम पूरा हुआ यह कैसे तय होता है?', 'प्रक्रिया आउटपुट आवश्यकताओं और समीक्षा नियमों के अनुसार आगे बढ़ती है। फ़ाइल मौजूद होना या स्वचालित समीक्षा पास होना व्यावसायिक आवश्यकताएँ पूरी होने का प्रमाण नहीं है। महत्वपूर्ण परिणामों के लिए प्रमाण और मानवीय निर्णय चाहिए।'],
      ['मेरी सामग्री कहाँ रखी जाती है?', 'प्रोजेक्ट और निष्पादन रिकॉर्ड आपके उपकरण या स्वयं प्रबंधित परिवेश में रहते हैं। बाहरी मॉडल उपयोग करने पर संबंधित संदर्भ चुने हुए इंजन के कॉन्फ़िगरेशन के अनुसार संबंधित सेवा को भेजा जाता है।'],
    ],
  },
  'sv-SE': {
    title: 'Innan du börjar.',
    items: [
      ['Kan jag börja utan att kunna utforma arbetsflöden?', 'Börja med en mall eller skissa flödet i chatten. Kontrollera sedan steg, indata, utdata och granskningspunkter på arbetsytan. Du behöver fortfarande ange målet och kontrollera att flödet passar uppgiften.'],
      ['När är ett arbetsflöde användbart?', 'För återkommande arbete, tydliga leveranskrav eller uppgifter med flera färdigheter i följd. Enkla engångsfrågor kan hanteras direkt i chatten.'],
      ['Hur avgörs att arbetet är färdigt?', 'Flödet följer utdatakrav och granskningsregler. En befintlig fil eller godkänd automatisk kontroll bevisar inte att verksamhetskraven är uppfyllda. Viktiga resultat kräver belägg och mänsklig bedömning.'],
      ['Var lagras mitt material?', 'Projekt och körningsloggar stannar på din enhet eller i en miljö som du själv förvaltar. Med externa modeller skickas relevant sammanhang till motsvarande tjänst enligt den valda motorns konfiguration.'],
    ],
  },
  'da-DK': {
    title: 'Før du begynder.',
    items: [
      ['Kan jeg starte uden at kunne designe arbejdsgange?', 'Start med en skabelon eller lav et udkast i chatten, og bekræft trin, input, output og kontrolpunkter på lærredet. Du skal stadig fastlægge målet og kontrollere, at forløbet passer til opgaven.'],
      ['Hvornår er en arbejdsgang nyttig?', 'Ved gentaget arbejde, klare leverancekrav eller opgaver med flere færdigheder i rækkefølge. Enkle enkeltstående spørgsmål kan håndteres direkte i chatten.'],
      ['Hvordan afgøres det, at arbejdet er færdigt?', 'Forløbet følger outputkrav og kontrolregler. En eksisterende fil eller bestået automatisk kontrol beviser ikke, at forretningskrav er opfyldt. Vigtige resultater kræver dokumentation og menneskelig vurdering.'],
      ['Hvor gemmes mine materialer?', 'Projekter og kørselslogge bliver på din enhed eller i dit selvadministrerede miljø. Ved brug af eksterne modeller sendes relevant kontekst til den tilsvarende tjeneste efter den valgte motors konfiguration.'],
    ],
  },
  'nb-NO': {
    title: 'Før du begynner.',
    items: [
      ['Kan jeg starte uten å kunne utforme arbeidsflyter?', 'Start med en mal eller lag et utkast i chatten, og kontroller trinn, inndata, utdata og vurderingspunkter på lerretet. Du må fortsatt definere målet og sjekke at flyten passer oppgaven.'],
      ['Når er en arbeidsflyt nyttig?', 'Ved gjentatt arbeid, tydelige leveransekrav eller oppgaver som trenger flere ferdigheter i rekkefølge. Enkle engangsspørsmål kan håndteres direkte i chatten.'],
      ['Hvordan avgjøres det om arbeidet er ferdig?', 'Flyten følger krav til utdata og vurderingsregler. En eksisterende fil eller bestått automatisk kontroll beviser ikke at forretningskravene er oppfylt. Viktige resultater trenger belegg og menneskelig vurdering.'],
      ['Hvor lagres materialet mitt?', 'Prosjekter og kjøringslogger blir på enheten din eller i et miljø du selv administrerer. Ved bruk av eksterne modeller sendes relevant kontekst til den aktuelle tjenesten etter konfigurasjonen for valgt motor.'],
    ],
  },
  'fi-FI': {
    title: 'Ennen aloittamista.',
    items: [
      ['Voinko aloittaa osaamatta suunnitella työnkulkuja?', 'Aloita mallista tai luonnostele työnkulku keskustelussa ja tarkista vaiheet, syötteet, tulosteet sekä tarkistuskohdat piirtoalueella. Sinun on silti määriteltävä tavoite ja varmistettava työnkulun sopivuus tehtävään.'],
      ['Milloin työnkulku on hyödyllinen?', 'Toistuvassa työssä, selkeissä toimitusvaatimuksissa tai tehtävissä, joissa tarvitaan useita taitoja peräkkäin. Yksinkertaiset kertaluonteiset kysymykset voi käsitellä suoraan keskustelussa.'],
      ['Miten työn valmistuminen päätellään?', 'Työnkulku noudattaa tulostusvaatimuksia ja tarkistussääntöjä. Tiedoston olemassaolo tai automaattisen tarkistuksen läpäisy ei todista liiketoimintavaatimusten täyttymistä. Tärkeät tulokset tarvitsevat näyttöä ja ihmisen arviointia.'],
      ['Missä aineistoni säilytetään?', 'Projektit ja suorituslokit pysyvät laitteellasi tai itse hallitsemassasi ympäristössä. Ulkoisia malleja käytettäessä olennainen konteksti lähetetään vastaavaan palveluun valitun moottorin asetusten mukaisesti.'],
    ],
  },
  'cs-CZ': {
    title: 'Než začnete.',
    items: [
      ['Mohu začít, i když neumím navrhnout pracovní postup?', 'Začněte šablonou nebo návrhem v chatu a poté na plátně ověřte kroky, vstupy, výstupy a kontrolní body. Stále musíte určit cíl a ověřit, že postup odpovídá úkolu.'],
      ['Kdy je pracovní postup užitečný?', 'Pro opakovanou práci, jasné požadavky na výstupy nebo úkoly s několika navazujícími dovednostmi. Jednoduché jednorázové otázky lze řešit přímo v chatu.'],
      ['Jak se pozná, že je práce hotová?', 'Postup sleduje požadavky na výstupy a pravidla kontroly. Existence souboru nebo úspěšná automatická kontrola nedokazuje splnění obchodních požadavků. Důležité výsledky potřebují důkazy a lidské posouzení.'],
      ['Kde jsou uloženy mé podklady?', 'Projekty a záznamy běhů zůstávají na vašem zařízení nebo ve vámi spravovaném prostředí. Při použití externích modelů se příslušný kontext odesílá odpovídající službě podle konfigurace zvoleného enginu.'],
    ],
  },
  'el-GR': {
    title: 'Πριν ξεκινήσετε.',
    items: [
      ['Μπορώ να ξεκινήσω χωρίς να ξέρω να σχεδιάζω ροές;', 'Ξεκινήστε με πρότυπο ή σχεδιάστε τη ροή στη συνομιλία και ελέγξτε βήματα, εισόδους, εξόδους και σημεία ελέγχου στον καμβά. Πρέπει ακόμη να ορίσετε τον στόχο και να ελέγξετε ότι η ροή ταιριάζει στην εργασία.'],
      ['Πότε είναι χρήσιμη μια ροή εργασίας;', 'Για επαναλαμβανόμενες εργασίες, σαφή παραδοτέα ή εργασίες που χρειάζονται διαδοχικά πολλές δεξιότητες. Απλές μεμονωμένες ερωτήσεις μπορούν να γίνουν απευθείας στη συνομιλία.'],
      ['Πώς κρίνεται ότι η εργασία ολοκληρώθηκε;', 'Η ροή ακολουθεί απαιτήσεις εξόδου και κανόνες ελέγχου. Η ύπαρξη αρχείου ή η επιτυχία αυτόματου ελέγχου δεν αποδεικνύει ότι καλύφθηκαν οι επιχειρησιακές απαιτήσεις. Σημαντικά αποτελέσματα χρειάζονται τεκμήρια και ανθρώπινη κρίση.'],
      ['Πού αποθηκεύεται το υλικό μου;', 'Τα έργα και τα αρχεία εκτέλεσης παραμένουν στη συσκευή σας ή σε δικό σας διαχειριζόμενο περιβάλλον. Με εξωτερικά μοντέλα, το σχετικό πλαίσιο αποστέλλεται στην αντίστοιχη υπηρεσία σύμφωνα με τη ρύθμιση της επιλεγμένης μηχανής.'],
    ],
  },
  'he-IL': {
    title: 'לפני שמתחילים.',
    items: [
      ['אפשר להתחיל בלי לדעת לתכנן תהליך עבודה?', 'אפשר להתחיל מתבנית או לנסח תהליך בשיחה, ואז לבדוק שלבים, קלטים, פלטים ונקודות ביקורת על הקנבס. עדיין צריך להגדיר מטרה ולוודא שהתהליך מתאים למשימה.'],
      ['מתי כדאי להשתמש בתהליך עבודה?', 'לעבודה חוזרת, לתוצרים מוגדרים או למשימות הדורשות כמה מיומנויות ברצף. שאלות פשוטות וחד־פעמיות אפשר לטפל בהן ישירות בשיחה.'],
      ['איך נקבע שהעבודה הסתיימה?', 'התהליך מתקדם לפי דרישות הפלט וכללי הביקורת. קובץ קיים או מעבר ביקורת אוטומטית אינם הוכחה לעמידה בדרישות העסקיות. תוצאות חשובות עדיין דורשות ראיות ושיקול דעת אנושי.'],
      ['היכן נשמרים החומרים שלי?', 'פרויקטים ורישומי הפעלה נשארים במכשיר או בסביבה שבניהולך. בשימוש במודלים חיצוניים, ההקשר הרלוונטי נשלח לשירות המתאים לפי הגדרת המנוע שנבחר.'],
    ],
  },
  'ar': {
    title: 'قبل أن تبدأ.',
    items: [
      ['هل يمكنني البدء دون معرفة تصميم سير العمل؟', 'ابدأ بقالب أو صمّم مسودة عبر المحادثة، ثم راجع الخطوات والمدخلات والمخرجات ونقاط المراجعة على اللوحة. ما زلت بحاجة إلى تحديد الهدف والتأكد من ملاءمة السير للمهمة.'],
      ['متى يكون سير العمل مفيدًا؟', 'للعمل المتكرر أو المخرجات المحددة بوضوح أو المهام التي تحتاج إلى مهارات متتابعة. يمكن التعامل مع الأسئلة البسيطة لمرة واحدة مباشرة في المحادثة.'],
      ['كيف يُحدد أن العمل اكتمل؟', 'يتقدم السير وفق متطلبات المخرجات وقواعد المراجعة. وجود ملف أو اجتياز مراجعة آلية لا يثبت تلبية متطلبات العمل. النتائج المهمة ما زالت تحتاج إلى أدلة وتقدير بشري.'],
      ['أين تُحفظ موادي؟', 'تبقى المشاريع وسجلات التنفيذ على جهازك أو في بيئة تديرها بنفسك. عند استخدام نماذج خارجية، يُرسل السياق المعني إلى الخدمة المقابلة وفق إعدادات المحرك المختار.'],
    ],
  },
}
