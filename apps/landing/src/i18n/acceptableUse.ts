import type { Lang } from './index'

interface AcceptableUseCopy {
  title: string
  intro: string
  prohibitedTitle: string
  prohibited: string[]
  reviewTitle: string
  review: string
  reportsTitle: string
  reports: string
  services: string
}

export const acceptableUseCopy: Record<Lang, AcceptableUseCopy> = {
  "zh-CN": {
    "title": "可接受使用政策",
    "intro": "本政策说明 WorkStep 的 AI 工作流与官方服务的可接受使用范围，涵盖提示词、AI 生成的代码与文本、其他产物及其传播。请仅使用你有权访问的数据、项目、工具与账号，遵守适用法律以及所连接模型和工具供应商的条款与安全政策。",
    "prohibitedTitle": "禁止用途",
    "prohibited": [
      "禁止使用 WorkStep 的 AI 工作流生成色情、露骨性内容或 NSFW 内容，或对这些内容进行转换、传播；禁止性剥削及任何涉及未成年人的性内容。此禁令也涵盖旨在生成或促成上述内容的代码、文本与工作流。",
      "禁止协助违法活动、欺诈、诈骗、冒充他人、剥削未成年人、人口贩运，或提供旨在造成身体伤害的指引。",
      "禁止生成或部署恶意软件、勒索软件、钓鱼内容、凭据窃取或破坏性代码，以及用于未授权访问的工具。安全测试必须获得相关系统拥有者的授权。",
      "禁止未经授权收集、披露或滥用个人数据、保密文件、凭据或私人通信；禁止人肉搜索、跟踪或非法监视。",
      "禁止定向骚扰、威胁、仇恨辱骂、欺骗性垃圾信息，或侵犯知识产权及其他权利的内容。",
      "禁止绕过供应商的安全控制或访问限制，或通过更换引擎、工作流步骤或输出格式掩饰被禁止的活动。"
    ],
    "reviewTitle": "检查与责任",
    "review": "你应对输入、权限、执行行为及产物的使用或分享负责。运行或发布前，须人工检查生成代码与文本的安全性、准确性、隐私与权利问题。AI 产物可能错误或不安全。配置工作流不代表获得系统访问或内容发布授权。",
    "reportsTitle": "举报与官方服务",
    "reports": "如发现涉嫌滥用，请联系下方支持邮箱，提供简要说明，以及已有的公开链接。不要发送身份证件、家庭住址、密码、API 密钥、私人对话或私有项目文件；支持材料中的个人信息须先脱敏。",
    "services": "对于违反本政策的行为，WorkStep 可依法限制或暂停相关官方服务。本说明不代表集中监控本地工作流，也不保证检测出全部违规产物。软件仍适用 Apache License 2.0；本政策不修改该许可证，也不取消其授予的权利。"
  },
  "en-US": {
    "title": "Acceptable Use Policy",
    "intro": "This policy describes acceptable use of WorkStep's AI workflows and official services, including prompts, AI-generated code and text, other outputs, and their distribution. Use only data, projects, tools and accounts you are authorized to access. Follow applicable law and the terms and safety policies of connected model and tool providers.",
    "prohibitedTitle": "Prohibited uses",
    "prohibited": [
      "Do not use WorkStep's AI workflows to generate, transform or distribute sexually explicit or NSFW content, pornography, sexual exploitation, or sexual content involving minors. This prohibition includes code, text and workflows intended to produce or facilitate such content.",
      "Do not facilitate illegal activity, fraud, scams, impersonation, exploitation of minors, human trafficking, or instructions intended to cause physical harm.",
      "Do not generate or deploy malware, ransomware, phishing, credential theft, destructive code or tools for unauthorized access. Security testing must be authorized by the owner of the systems involved.",
      "Do not collect, expose or misuse personal data, confidential files, credentials or private communications without authorization. Do not use workflows for doxxing, stalking or unlawful surveillance.",
      "Do not produce targeted harassment, threats, hateful abuse, deceptive spam, or content that infringes intellectual-property or other rights.",
      "Do not bypass provider safety controls or access restrictions, or disguise prohibited activity through another engine, workflow step or output format."
    ],
    "reviewTitle": "Review and responsibility",
    "review": "You are responsible for your inputs, permissions, execution and use or sharing of outputs. Review generated code and text for safety, accuracy, privacy and rights before running or publishing them. AI outputs may be incorrect or unsafe. A configured workflow does not establish permission to access a system or publish content.",
    "reportsTitle": "Reports and official services",
    "reports": "Report suspected misuse to the support address below with a brief description and, where available, a public URL. Do not send identity documents, home addresses, passwords, API keys, private conversations or private project files. Redact personal information from any supporting material.",
    "services": "WorkStep may restrict or suspend access to official services for violations of this policy, subject to applicable law. This statement does not claim that local workflows are centrally monitored or that all prohibited outputs can be detected. The software remains licensed under Apache License 2.0; this policy does not amend that license or remove rights granted by it."
  },
  "zh-TW": {
    "title": "可接受使用政策",
    "intro": "本政策說明 WorkStep 的 AI 協作流程與官方服務的可接受使用範圍，涵蓋提示詞、AI 生成的程式碼與文字、其他產物及其傳播。請僅使用你有權存取的資料、專案、工具與帳號，遵守適用法律及所連接模型和工具供應商的條款與安全政策。",
    "prohibitedTitle": "禁止用途",
    "prohibited": [
      "禁止生成、轉換或傳播色情、露骨性內容或 NSFW 內容，禁止性剝削及任何涉及未成年人的性內容；亦禁止旨在生成或促成上述內容的程式碼、文字與流程。",
      "禁止協助違法活動、欺詐、詐騙、冒充他人、剝削未成年人、人口販運，或提供旨在造成身體傷害的指引。",
      "禁止生成或部署惡意軟體、勒索軟體、釣魚內容、憑證竊取、破壞性程式碼或未經授權存取的工具。安全測試須獲相關系統擁有者授權。",
      "禁止未經授權蒐集、披露或濫用個人資料、機密檔案、憑證或私人通訊；禁止人肉搜尋、跟蹤或非法監視。",
      "禁止定向騷擾、威脅、仇恨辱罵、欺騙性垃圾訊息，或侵犯智慧財產權及其他權利的內容。",
      "禁止繞過供應商安全控制或存取限制，或透過更換引擎、流程步驟或輸出格式掩飾被禁止的活動。"
    ],
    "reviewTitle": "檢查與責任",
    "review": "你須對輸入、權限、執行及產物的使用或分享負責。執行或發布前，請檢查生成程式碼與文字的安全性、準確性、隱私及權利問題。AI 產物可能錯誤或不安全。設定流程不代表獲得系統存取或內容發布授權。",
    "reportsTitle": "檢舉與官方服務",
    "reports": "如發現疑似濫用，請聯絡下方支援信箱，提供簡述及已有的公開連結。不要傳送身分證件、住址、密碼、API 金鑰、私人對話或私有專案檔案；請先將佐證資料中的個人資訊去識別化。",
    "services": "WorkStep 可依法限制或暫停違反本政策者使用相關官方服務；這不代表集中監控本機流程，也不保證偵測所有違規產物。軟體仍適用 Apache License 2.0；本政策不修改該授權或取消其授予的權利。"
  },
  "ja-JP": {
    "title": "利用ポリシー",
    "intro": "本ポリシーは WorkStep の AI プロセスと公式サービス（プロンプト、生成コード・文章、その他の成果物と配布）に適用されます。権限のあるデータ、プロジェクト、ツール、アカウントのみを使用し、法令および接続先の規約と安全方針を守ってください。",
    "prohibitedTitle": "禁止事項",
    "prohibited": [
      "性的に露骨な内容、ポルノ、NSFW、性的搾取、未成年者の性的内容の生成・変換・配布、およびそれを促すコード・文章・プロセス。",
      "違法行為、詐欺、なりすまし、未成年者の搾取、人身売買、身体的危害を目的とする指示。",
      "マルウェア、ランサムウェア、フィッシング、認証情報窃取、破壊的コード、不正アクセスのツール。セキュリティテストにはシステム所有者の許可が必要です。",
      "個人情報、機密ファイル、認証情報、私的通信の無断収集・公開・悪用、晒し、ストーカー行為、違法監視。",
      "標的型嫌がらせ、脅迫、ヘイト、欺瞞的スパム、知的財産権その他の権利侵害。",
      "提供者の安全管理やアクセス制限の回避、エンジン・ステップ・形式の変更による禁止行為の隠蔽。"
    ],
    "reviewTitle": "確認と責任",
    "review": "入力、権限、実行、成果物の使用・共有は利用者の責任です。実行・公開前にコードや文章の安全性、正確性、プライバシー、権利を確認してください。AI 出力は誤りや危険を含み得ます。設定自体はアクセスや公開の許可ではありません。",
    "reportsTitle": "通報と公式サービス",
    "reports": "不正利用の疑いは下記サポートへ概要と公開URLで報告してください。身分証、住所、パスワード、APIキー、私的会話、非公開プロジェクトは送らず、個人情報を伏せてください。",
    "services": "違反には法令に従い公式サービスを制限・停止する場合があります。ローカル処理の集中監視や全違反の検知を意味しません。Apache License 2.0 は引き続き適用され、本ポリシーはライセンスや付与された権利を変更しません。"
  },
  "ko-KR": {
    "title": "허용되는 사용 정책",
    "intro": "이 정책은 WorkStep의 AI 처리 과정과 공식 서비스, 프롬프트, 생성 코드·텍스트, 기타 결과물과 배포에 적용됩니다. 접근 권한이 있는 데이터·프로젝트·도구·계정만 사용하고 관련 법률 및 연결된 공급자의 약관과 안전 정책을 준수하세요.",
    "prohibitedTitle": "금지 용도",
    "prohibited": [
      "음란물, 노골적인 성적·NSFW 콘텐츠, 성적 착취 및 미성년자 관련 성적 콘텐츠의 생성·변환·배포와 이를 돕는 코드·텍스트·처리 과정.",
      "불법 행위, 사기, 기만, 사칭, 미성년자 착취, 인신매매 또는 신체적 위해를 목적으로 한 지침.",
      "악성코드, 랜섬웨어, 피싱, 자격 증명 탈취, 파괴적 코드 및 무단 접근 도구. 보안 테스트에는 시스템 소유자의 허가가 필요합니다.",
      "개인정보·기밀 파일·자격 증명·사적 통신의 무단 수집·공개·악용, 신상 공개, 스토킹, 불법 감시.",
      "표적 괴롭힘, 위협, 혐오, 기만적 스팸, 지식재산권 및 기타 권리 침해.",
      "공급자의 안전 통제·접근 제한 우회 또는 엔진·단계·출력 형식을 바꿔 금지 행위를 숨기는 행위."
    ],
    "reviewTitle": "검토와 책임",
    "review": "입력, 권한, 실행 및 결과물 사용·공유는 사용자 책임입니다. 실행·게시 전에 생성 코드와 텍스트의 안전성, 정확성, 개인정보와 권리를 검토하세요. AI 결과물은 틀리거나 위험할 수 있습니다. 설정만으로 접근·게시 권한을 얻는 것은 아닙니다.",
    "reportsTitle": "신고와 공식 서비스",
    "reports": "의심되는 악용은 아래 지원 이메일로 간단한 설명과 공개 링크를 보내세요. 신분증, 주소, 비밀번호, API 키, 사적 대화, 비공개 프로젝트 파일은 보내지 말고 개인정보는 가리세요.",
    "services": "법률에 따라 위반자의 공식 서비스 접근을 제한·중지할 수 있습니다. 로컬 처리 과정을 중앙 감시하거나 모든 위반을 탐지한다는 의미는 아닙니다. Apache License 2.0은 계속 적용되며 이 정책은 해당 라이선스와 그 권리를 변경하지 않습니다."
  },
  "fr-FR": {
    "title": "Politique d’utilisation acceptable",
    "intro": "Cette politique couvre les processus IA et services officiels de WorkStep, les instructions, le code et le texte générés, les autres résultats et leur diffusion. Utilisez uniquement des données, projets, outils et comptes autorisés, conformément à la loi et aux conditions et politiques de sécurité des fournisseurs connectés.",
    "prohibitedTitle": "Usages interdits",
    "prohibited": [
      "Créer, transformer ou diffuser des contenus pornographiques, sexuellement explicites ou NSFW, de l’exploitation sexuelle ou des contenus sexuels impliquant des mineurs, y compris le code, le texte et les processus qui les facilitent.",
      "Faciliter des activités illégales, fraudes, escroqueries, usurpations, l’exploitation de mineurs, la traite humaine ou des instructions visant à blesser.",
      "Créer ou déployer des logiciels malveillants, rançongiciels, hameçonnage, vols d’identifiants, code destructeur ou outils d’accès non autorisé. Les tests de sécurité exigent l’autorisation du propriétaire.",
      "Collecter, divulguer ou exploiter sans autorisation des données personnelles, fichiers confidentiels, identifiants ou communications privées ; divulgation d’identité, traque ou surveillance illégale.",
      "Harcèlement ciblé, menaces, haine, spam trompeur ou atteintes à la propriété intellectuelle et aux autres droits.",
      "Contourner les protections ou restrictions d’accès des fournisseurs, ou dissimuler un usage interdit en changeant de moteur, d’étape ou de format."
    ],
    "reviewTitle": "Vérification et responsabilité",
    "review": "Vous êtes responsable des entrées, autorisations, exécutions et de l’utilisation ou du partage des résultats. Vérifiez sécurité, exactitude, vie privée et droits avant exécution ou publication. Les résultats IA peuvent être erronés ou dangereux. La configuration ne constitue pas une autorisation d’accès ou de publication.",
    "reportsTitle": "Signalements et services officiels",
    "reports": "Signalez les abus au support ci-dessous avec un bref descriptif et un lien public disponible. N’envoyez ni pièce d’identité, adresse personnelle, mot de passe, clé API, conversation privée ni fichier de projet privé. Masquez les données personnelles.",
    "services": "WorkStep peut légalement restreindre ou suspendre les services officiels en cas de violation. Cela n’implique ni surveillance centralisée des processus locaux ni détection de tous les abus. Apache License 2.0 reste applicable ; cette politique ne modifie ni la licence ni les droits accordés."
  },
  "de-DE": {
    "title": "Richtlinie zur zulässigen Nutzung",
    "intro": "Diese Richtlinie gilt für die KI-Prozesse und offiziellen Dienste von WorkStep, Eingaben, erzeugten Code und Text, andere Ergebnisse und deren Verbreitung. Nutzen Sie nur autorisierte Daten, Projekte, Werkzeuge und Konten und beachten Sie Gesetze sowie Bedingungen und Sicherheitsregeln angeschlossener Anbieter.",
    "prohibitedTitle": "Unzulässige Nutzung",
    "prohibited": [
      "Erzeugen, Umwandeln oder Verbreiten pornografischer, sexuell expliziter oder NSFW-Inhalte, sexueller Ausbeutung oder sexueller Inhalte mit Minderjährigen, einschließlich unterstützendem Code, Text und Prozessen.",
      "Förderung illegaler Handlungen, Betrug, Täuschung, Identitätsmissbrauch, Ausbeutung Minderjähriger, Menschenhandel oder Anleitungen zur körperlichen Schädigung.",
      "Schadsoftware, Ransomware, Phishing, Diebstahl von Zugangsdaten, zerstörerischer Code oder Werkzeuge für unbefugten Zugriff. Sicherheitstests benötigen die Erlaubnis des Systeminhabers.",
      "Unbefugte Sammlung, Offenlegung oder missbräuchliche Nutzung persönlicher Daten, vertraulicher Dateien, Zugangsdaten oder privater Kommunikation; Doxxing, Stalking oder illegale Überwachung.",
      "Gezielte Belästigung, Drohungen, Hass, irreführender Spam oder Verletzung geistigen Eigentums und anderer Rechte.",
      "Umgehung von Sicherheits- oder Zugriffskontrollen oder Verschleierung verbotener Aktivitäten durch andere Engines, Schritte oder Ausgabeformate."
    ],
    "reviewTitle": "Prüfung und Verantwortung",
    "review": "Sie verantworten Eingaben, Berechtigungen, Ausführung sowie Nutzung und Weitergabe der Ergebnisse. Prüfen Sie Sicherheit, Richtigkeit, Datenschutz und Rechte vor Ausführung oder Veröffentlichung. KI-Ergebnisse können falsch oder unsicher sein. Eine Konfiguration erteilt keine Zugriffs- oder Veröffentlichungserlaubnis.",
    "reportsTitle": "Meldungen und offizielle Dienste",
    "reports": "Melden Sie vermuteten Missbrauch mit kurzer Beschreibung und vorhandenem öffentlichem Link an den Support unten. Senden Sie keine Ausweise, Privatadressen, Passwörter, API-Schlüssel, privaten Gespräche oder Projektdateien. Schwärzen Sie personenbezogene Daten.",
    "services": "WorkStep kann offizielle Dienste bei Verstößen im gesetzlichen Rahmen einschränken oder aussetzen. Dies bedeutet weder zentrale Überwachung lokaler Prozesse noch Erkennung aller Verstöße. Apache License 2.0 gilt weiterhin; diese Richtlinie ändert weder die Lizenz noch gewährte Rechte."
  },
  "it-IT": {
    "title": "Politica di utilizzo accettabile",
    "intro": "Questa politica riguarda processi IA e servizi ufficiali di WorkStep, prompt, codice e testo generati, altri risultati e la loro distribuzione. Usa solo dati, progetti, strumenti e account autorizzati e rispetta leggi, termini e politiche di sicurezza dei fornitori collegati.",
    "prohibitedTitle": "Usi vietati",
    "prohibited": [
      "Generare, trasformare o distribuire pornografia, contenuti sessualmente espliciti o NSFW, sfruttamento sessuale o contenuti sessuali con minori, inclusi codice, testo e processi che li facilitano.",
      "Agevolare attività illegali, frodi, truffe, impersonificazione, sfruttamento di minori, tratta di persone o istruzioni per causare danni fisici.",
      "Malware, ransomware, phishing, furto di credenziali, codice distruttivo o strumenti per accessi non autorizzati. I test di sicurezza richiedono il consenso del proprietario del sistema.",
      "Raccogliere, divulgare o abusare senza permesso di dati personali, file riservati, credenziali o comunicazioni private; doxxing, stalking o sorveglianza illegale.",
      "Molestie mirate, minacce, odio, spam ingannevole o violazioni della proprietà intellettuale e di altri diritti.",
      "Eludere le protezioni o i limiti di accesso dei fornitori, o nascondere attività vietate cambiando motore, fase o formato."
    ],
    "reviewTitle": "Verifica e responsabilità",
    "review": "Sei responsabile di input, permessi, esecuzione e uso o condivisione dei risultati. Controlla sicurezza, accuratezza, privacy e diritti prima di eseguire o pubblicare. I risultati IA possono essere errati o pericolosi. La configurazione non autorizza accessi o pubblicazioni.",
    "reportsTitle": "Segnalazioni e servizi ufficiali",
    "reports": "Segnala sospetti abusi al supporto sotto con una breve descrizione e un eventuale URL pubblico. Non inviare documenti, indirizzi di casa, password, chiavi API, conversazioni o progetti privati. Oscura i dati personali.",
    "services": "WorkStep può limitare o sospendere i servizi ufficiali per violazioni, nei limiti di legge. Non implica monitoraggio centralizzato dei processi locali né rilevamento di tutti gli abusi. Apache License 2.0 resta applicabile; questa politica non modifica la licenza o i diritti concessi."
  },
  "nl-NL": {
    "title": "Beleid voor aanvaardbaar gebruik",
    "intro": "Dit beleid geldt voor de AI-processen en officiële diensten van WorkStep, prompts, gegenereerde code en tekst, andere resultaten en verspreiding daarvan. Gebruik alleen toegestane gegevens, projecten, tools en accounts en volg de wet en de voorwaarden en veiligheidsregels van aangesloten aanbieders.",
    "prohibitedTitle": "Verboden gebruik",
    "prohibited": [
      "Pornografische, seksueel expliciete of NSFW-inhoud, seksuele uitbuiting of seksuele inhoud met minderjarigen maken, omzetten of verspreiden, inclusief ondersteunende code, tekst en processen.",
      "Illegale activiteiten, fraude, oplichting, identiteitsmisbruik, uitbuiting van minderjarigen, mensenhandel of instructies voor lichamelijk letsel faciliteren.",
      "Malware, ransomware, phishing, diefstal van inloggegevens, destructieve code of tools voor onbevoegde toegang. Beveiligingstests vereisen toestemming van de systeemeigenaar.",
      "Zonder toestemming persoonsgegevens, vertrouwelijke bestanden, inloggegevens of privécommunicatie verzamelen, delen of misbruiken; doxxing, stalking of onwettig toezicht.",
      "Gerichte intimidatie, bedreigingen, haat, misleidende spam of schending van intellectuele eigendom en andere rechten.",
      "Veiligheids- of toegangscontroles omzeilen, of verboden activiteiten verbergen via andere engines, stappen of uitvoerformaten."
    ],
    "reviewTitle": "Controle en verantwoordelijkheid",
    "review": "U bent verantwoordelijk voor invoer, rechten, uitvoering en gebruik of delen van resultaten. Controleer veiligheid, juistheid, privacy en rechten vóór uitvoering of publicatie. AI-resultaten kunnen onjuist of onveilig zijn. Configuratie geeft geen toestemming voor toegang of publicatie.",
    "reportsTitle": "Meldingen en officiële diensten",
    "reports": "Meld vermoedelijk misbruik aan onderstaande ondersteuning met een korte beschrijving en beschikbare openbare URL. Stuur geen identiteitsdocumenten, privé-adressen, wachtwoorden, API-sleutels, privégesprekken of projectbestanden. Verwijder persoonsgegevens uit bewijs.",
    "services": "WorkStep kan officiële diensten wegens overtredingen wettelijk beperken of opschorten. Dit impliceert geen centrale bewaking van lokale processen of detectie van alle overtredingen. Apache License 2.0 blijft gelden; dit beleid wijzigt de licentie en toegekende rechten niet."
  },
  "ru-RU": {
    "title": "Правила допустимого использования",
    "intro": "Правила распространяются на процессы ИИ и официальные сервисы WorkStep, запросы, созданные код и текст, другие результаты и их распространение. Используйте только разрешённые данные, проекты, инструменты и аккаунты, соблюдайте закон, условия и правила безопасности подключённых поставщиков.",
    "prohibitedTitle": "Запрещённое использование",
    "prohibited": [
      "Создание, преобразование или распространение порнографии, откровенно сексуального или NSFW-контента, сексуальной эксплуатации и сексуального контента с несовершеннолетними, включая содействующие этому код, текст и процессы.",
      "Содействие незаконной деятельности, мошенничеству, обману, выдаче себя за других, эксплуатации детей, торговле людьми или инструкциям по причинению физического вреда.",
      "Вредоносное ПО, программы-вымогатели, фишинг, кража учётных данных, разрушительный код и инструменты несанкционированного доступа. Проверка безопасности требует разрешения владельца системы.",
      "Несанкционированные сбор, раскрытие или злоупотребление персональными данными, конфиденциальными файлами, учётными данными или частной перепиской; доксинг, преследование и незаконная слежка.",
      "Целевая травля, угрозы, ненависть, обманный спам и нарушение интеллектуальных или иных прав.",
      "Обход защит и ограничений доступа поставщиков или сокрытие запрещённых действий сменой движка, этапа либо формата."
    ],
    "reviewTitle": "Проверка и ответственность",
    "review": "Вы отвечаете за ввод, разрешения, выполнение и использование или передачу результатов. Перед запуском или публикацией проверяйте безопасность, точность, приватность и права. ИИ может ошибаться и создавать опасные результаты. Настройка не даёт разрешения на доступ или публикацию.",
    "reportsTitle": "Сообщения и официальные сервисы",
    "reports": "Сообщайте о предполагаемых злоупотреблениях в поддержку ниже с кратким описанием и доступной публичной ссылкой. Не отправляйте документы, домашние адреса, пароли, API-ключи, частные беседы и файлы проектов. Удаляйте персональные данные из материалов.",
    "services": "WorkStep вправе законно ограничить или приостановить официальные сервисы за нарушения. Это не означает централизованный мониторинг локальных процессов или обнаружение всех нарушений. Apache License 2.0 продолжает действовать; эти правила не меняют лицензию и предоставленные права."
  },
  "pl-PL": {
    "title": "Zasady dopuszczalnego użytkowania",
    "intro": "Zasady obejmują procesy AI i oficjalne usługi WorkStep, polecenia, wygenerowany kod, tekst, inne wyniki i ich rozpowszechnianie. Używaj tylko dozwolonych danych, projektów, narzędzi i kont, zgodnie z prawem oraz warunkami i zasadami bezpieczeństwa dostawców.",
    "prohibitedTitle": "Zabronione zastosowania",
    "prohibited": [
      "Tworzenie, przekształcanie lub rozpowszechnianie pornografii, treści seksualnie dosłownych lub NSFW, wykorzystywania seksualnego i treści seksualnych z nieletnimi, w tym ułatwiającego to kodu, tekstu i procesów.",
      "Wspieranie przestępstw, oszustw, wyłudzeń, podszywania się, wykorzystywania dzieci, handlu ludźmi lub instrukcji wyrządzania szkód fizycznych.",
      "Złośliwe oprogramowanie, ransomware, phishing, kradzież danych logowania, niszczący kod i nieuprawniony dostęp. Testy bezpieczeństwa wymagają zgody właściciela systemu.",
      "Nieuprawnione zbieranie, ujawnianie lub nadużywanie danych osobowych, poufnych plików, danych logowania i prywatnej komunikacji; doxxing, stalking i nielegalna inwigilacja.",
      "Ukierunkowane nękanie, groźby, nienawiść, zwodniczy spam i naruszanie własności intelektualnej lub innych praw.",
      "Obchodzenie zabezpieczeń dostawców lub ograniczeń dostępu oraz ukrywanie zakazanych działań przez zmianę silnika, kroku lub formatu."
    ],
    "reviewTitle": "Kontrola i odpowiedzialność",
    "review": "Odpowiadasz za dane wejściowe, uprawnienia, wykonanie oraz użycie i udostępnianie wyników. Przed uruchomieniem lub publikacją sprawdź bezpieczeństwo, poprawność, prywatność i prawa. AI może tworzyć błędne lub niebezpieczne wyniki. Konfiguracja nie daje uprawnień do dostępu lub publikacji.",
    "reportsTitle": "Zgłoszenia i oficjalne usługi",
    "reports": "Podejrzenia nadużyć zgłaszaj do wsparcia poniżej, z krótkim opisem i dostępnym publicznym adresem. Nie wysyłaj dokumentów tożsamości, adresów domowych, haseł, kluczy API, prywatnych rozmów ani plików projektów. Usuń dane osobowe z materiałów.",
    "services": "WorkStep może zgodnie z prawem ograniczyć lub zawiesić oficjalne usługi za naruszenia. Nie oznacza to centralnego monitorowania lokalnych procesów ani wykrywania wszystkich naruszeń. Apache License 2.0 pozostaje w mocy; zasady nie zmieniają licencji ani udzielonych praw."
  },
  "tr-TR": {
    "title": "Kabul edilebilir kullanım politikası",
    "intro": "Bu politika WorkStep AI süreçlerini, resmi hizmetlerini, istemleri, üretilen kod ve metni, diğer çıktıları ve dağıtımını kapsar. Yalnızca yetkili olduğunuz veri, proje, araç ve hesapları kullanın; yasalara, bağlı sağlayıcıların koşul ve güvenlik politikalarına uyun.",
    "prohibitedTitle": "Yasak kullanımlar",
    "prohibited": [
      "Pornografi, açık cinsel veya NSFW içerik, cinsel sömürü ve reşit olmayanları içeren cinsel içerik üretmek, dönüştürmek veya dağıtmak; bunları kolaylaştıran kod, metin ve süreçler dahil.",
      "Yasa dışı faaliyet, dolandırıcılık, aldatma, kimliğe bürünme, çocuk istismarı, insan ticareti veya fiziksel zarar verme talimatlarını kolaylaştırmak.",
      "Kötü amaçlı yazılım, fidye yazılımı, kimlik avı, kimlik bilgisi hırsızlığı, yıkıcı kod veya yetkisiz erişim araçları. Güvenlik testleri sistem sahibinin iznini gerektirir.",
      "Kişisel verileri, gizli dosyaları, kimlik bilgilerini veya özel yazışmaları izinsiz toplamak, açıklamak veya kötüye kullanmak; ifşa, takip veya yasa dışı gözetim.",
      "Hedefli taciz, tehdit, nefret, aldatıcı spam veya fikri mülkiyet ve diğer hak ihlalleri.",
      "Sağlayıcı güvenlik veya erişim kontrollerini aşmak; motor, adım veya çıktı biçimini değiştirerek yasak faaliyeti gizlemek."
    ],
    "reviewTitle": "İnceleme ve sorumluluk",
    "review": "Girdilerden, izinlerden, çalıştırmadan ve çıktıların kullanım veya paylaşımından siz sorumlusunuz. Çalıştırma veya yayımlama öncesinde güvenlik, doğruluk, gizlilik ve hakları inceleyin. AI çıktıları yanlış veya güvensiz olabilir. Yapılandırma erişim veya yayın izni vermez.",
    "reportsTitle": "Bildirimler ve resmi hizmetler",
    "reports": "Şüpheli kötüye kullanımı kısa açıklama ve mevcut herkese açık bağlantıyla aşağıdaki desteğe bildirin. Kimlik belgesi, ev adresi, parola, API anahtarı, özel konuşma veya proje dosyası göndermeyin. Kişisel bilgileri karartın.",
    "services": "WorkStep ihlallerde yasalara uygun olarak resmi hizmetleri kısıtlayabilir veya askıya alabilir. Bu, yerel süreçlerin merkezi izlenmesi veya tüm ihlallerin saptanması anlamına gelmez. Apache License 2.0 geçerliliğini korur; politika lisansı veya verilen hakları değiştirmez."
  },
  "hi-IN": {
    "title": "स्वीकार्य उपयोग नीति",
    "intro": "यह नीति WorkStep की AI प्रक्रियाओं, आधिकारिक सेवाओं, प्रॉम्प्ट, उत्पन्न कोड, पाठ, अन्य परिणामों और उनके वितरण पर लागू है। केवल अधिकृत डेटा, परियोजनाएँ, उपकरण और खाते इस्तेमाल करें। कानून तथा जुड़े प्रदाताओं की शर्तों और सुरक्षा नीतियों का पालन करें।",
    "prohibitedTitle": "निषिद्ध उपयोग",
    "prohibited": [
      "अश्लील, स्पष्ट यौन या NSFW सामग्री, यौन शोषण या नाबालिगों से जुड़ी यौन सामग्री बनाना, बदलना या फैलाना; इन्हें सक्षम करने वाला कोड, पाठ और प्रक्रियाएँ भी निषिद्ध हैं।",
      "अवैध कार्य, धोखाधड़ी, ठगी, प्रतिरूपण, बाल शोषण, मानव तस्करी या शारीरिक नुकसान पहुँचाने के निर्देशों में सहायता।",
      "मैलवेयर, रैनसमवेयर, फ़िशिंग, क्रेडेंशियल चोरी, विनाशकारी कोड या अनधिकृत पहुँच के उपकरण। सुरक्षा परीक्षण के लिए सिस्टम स्वामी की अनुमति आवश्यक है।",
      "निजी डेटा, गोपनीय फ़ाइलें, क्रेडेंशियल या निजी संचार का अनधिकृत संग्रह, खुलासा या दुरुपयोग; पहचान उजागर करना, पीछा करना या अवैध निगरानी।",
      "लक्षित उत्पीड़न, धमकियाँ, घृणा, भ्रामक स्पैम या बौद्धिक संपदा व अन्य अधिकारों का उल्लंघन।",
      "प्रदाता की सुरक्षा या पहुँच सीमाओं को दरकिनार करना, या इंजन, चरण या प्रारूप बदलकर निषिद्ध कार्य छिपाना।"
    ],
    "reviewTitle": "जाँच और जिम्मेदारी",
    "review": "इनपुट, अनुमतियों, निष्पादन और परिणामों के उपयोग या साझाकरण की जिम्मेदारी आपकी है। चलाने या प्रकाशित करने से पहले सुरक्षा, सटीकता, निजता और अधिकार जाँचें। AI परिणाम गलत या असुरक्षित हो सकते हैं। कॉन्फ़िगरेशन से पहुँच या प्रकाशन की अनुमति नहीं मिलती।",
    "reportsTitle": "रिपोर्ट और आधिकारिक सेवाएँ",
    "reports": "संदिग्ध दुरुपयोग नीचे दिए समर्थन पते पर संक्षिप्त विवरण और उपलब्ध सार्वजनिक लिंक के साथ बताएँ। पहचान दस्तावेज़, घर का पता, पासवर्ड, API कुंजी, निजी बातचीत या परियोजना फ़ाइलें न भेजें। साक्ष्य से निजी जानकारी हटाएँ।",
    "services": "उल्लंघन पर WorkStep कानून के अनुसार आधिकारिक सेवाएँ सीमित या निलंबित कर सकता है। इसका अर्थ स्थानीय प्रक्रियाओं की केंद्रीय निगरानी या सभी उल्लंघनों का पता लगाना नहीं है। Apache License 2.0 लागू रहता है; यह नीति लाइसेंस या प्रदत्त अधिकार नहीं बदलती।"
  },
  "id-ID": {
    "title": "Kebijakan penggunaan yang dapat diterima",
    "intro": "Kebijakan ini mencakup proses AI dan layanan resmi WorkStep, prompt, kode dan teks yang dihasilkan, keluaran lain serta distribusinya. Gunakan hanya data, proyek, alat dan akun yang diizinkan; patuhi hukum, ketentuan dan kebijakan keselamatan penyedia yang terhubung.",
    "prohibitedTitle": "Penggunaan terlarang",
    "prohibited": [
      "Membuat, mengubah atau menyebarkan pornografi, konten seksual eksplisit atau NSFW, eksploitasi seksual atau konten seksual yang melibatkan anak; termasuk kode, teks dan proses yang memfasilitasinya.",
      "Memfasilitasi tindakan ilegal, penipuan, penyamaran, eksploitasi anak, perdagangan manusia atau petunjuk untuk menyakiti secara fisik.",
      "Malware, ransomware, phishing, pencurian kredensial, kode perusak atau alat akses tanpa izin. Pengujian keamanan memerlukan izin pemilik sistem.",
      "Mengumpulkan, mengungkap atau menyalahgunakan data pribadi, berkas rahasia, kredensial atau komunikasi pribadi tanpa izin; doxxing, penguntitan atau pengawasan ilegal.",
      "Pelecehan terarah, ancaman, kebencian, spam menipu atau pelanggaran kekayaan intelektual dan hak lain.",
      "Melewati pengamanan atau pembatasan akses penyedia, atau menyamarkan kegiatan terlarang dengan mengganti mesin, langkah atau format."
    ],
    "reviewTitle": "Peninjauan dan tanggung jawab",
    "review": "Anda bertanggung jawab atas masukan, izin, eksekusi serta penggunaan atau pembagian keluaran. Periksa keamanan, ketepatan, privasi dan hak sebelum menjalankan atau menerbitkan. Keluaran AI dapat salah atau tidak aman. Konfigurasi bukan izin akses atau publikasi.",
    "reportsTitle": "Pelaporan dan layanan resmi",
    "reports": "Laporkan dugaan penyalahgunaan kepada dukungan di bawah dengan penjelasan singkat dan URL publik yang tersedia. Jangan kirim dokumen identitas, alamat rumah, kata sandi, kunci API, percakapan atau berkas proyek pribadi. Samarkan data pribadi.",
    "services": "WorkStep dapat membatasi atau menangguhkan layanan resmi atas pelanggaran sesuai hukum. Ini tidak berarti pemantauan terpusat proses lokal atau deteksi semua pelanggaran. Apache License 2.0 tetap berlaku; kebijakan ini tidak mengubah lisensi atau hak yang diberikan."
  },
  "vi-VN": {
    "title": "Chính sách sử dụng chấp nhận được",
    "intro": "Chính sách áp dụng cho quy trình AI và dịch vụ chính thức của WorkStep, lời nhắc, mã và văn bản tạo ra, các kết quả khác cùng việc phân phối. Chỉ sử dụng dữ liệu, dự án, công cụ và tài khoản được phép; tuân thủ pháp luật, điều khoản và chính sách an toàn của nhà cung cấp kết nối.",
    "prohibitedTitle": "Các hành vi bị cấm",
    "prohibited": [
      "Tạo, chuyển đổi hoặc phát tán nội dung khiêu dâm, tình dục rõ ràng hoặc NSFW, bóc lột tình dục hoặc nội dung tình dục liên quan trẻ vị thành niên; kể cả mã, văn bản và quy trình hỗ trợ.",
      "Hỗ trợ hành vi phi pháp, gian lận, lừa đảo, mạo danh, bóc lột trẻ em, buôn người hoặc chỉ dẫn gây tổn hại thân thể.",
      "Phần mềm độc hại, mã độc tống tiền, lừa đảo, đánh cắp thông tin xác thực, mã phá hoại hoặc công cụ truy cập trái phép. Kiểm thử bảo mật phải có phép của chủ hệ thống.",
      "Thu thập, tiết lộ hoặc lạm dụng dữ liệu cá nhân, tệp mật, thông tin xác thực hay liên lạc riêng tư khi chưa được phép; công khai danh tính, theo dõi hoặc giám sát bất hợp pháp.",
      "Quấy rối có mục tiêu, đe dọa, thù hận, thư rác lừa dối hoặc vi phạm sở hữu trí tuệ và quyền khác.",
      "Vượt kiểm soát an toàn, hạn chế truy cập của nhà cung cấp hoặc che giấu hành vi bị cấm bằng cách đổi bộ máy, bước hay định dạng."
    ],
    "reviewTitle": "Kiểm tra và trách nhiệm",
    "review": "Bạn chịu trách nhiệm về đầu vào, quyền, thực thi và sử dụng hoặc chia sẻ kết quả. Kiểm tra an toàn, độ chính xác, riêng tư và quyền trước khi chạy hoặc công bố. AI có thể sai hoặc không an toàn. Cấu hình không phải là quyền truy cập hay công bố.",
    "reportsTitle": "Báo cáo và dịch vụ chính thức",
    "reports": "Báo cáo nghi ngờ lạm dụng tới hỗ trợ bên dưới với mô tả ngắn và liên kết công khai nếu có. Không gửi giấy tờ tùy thân, địa chỉ nhà, mật khẩu, khóa API, hội thoại hoặc tệp dự án riêng. Ẩn thông tin cá nhân trong bằng chứng.",
    "services": "WorkStep có thể hạn chế hoặc đình chỉ dịch vụ chính thức khi vi phạm theo pháp luật. Điều này không có nghĩa giám sát tập trung quy trình cục bộ hay phát hiện mọi vi phạm. Apache License 2.0 vẫn áp dụng; chính sách không sửa giấy phép hoặc quyền được cấp."
  },
  "es-ES": {
    "title": "Política de uso aceptable",
    "intro": "Esta política cubre los procesos de IA y servicios oficiales de WorkStep, instrucciones, código y texto generados, otros resultados y su difusión. Usa únicamente datos, proyectos, herramientas y cuentas autorizados; cumple la ley y las condiciones y políticas de seguridad de los proveedores conectados.",
    "prohibitedTitle": "Usos prohibidos",
    "prohibited": [
      "Crear, transformar o distribuir pornografía, contenido sexual explícito o NSFW, explotación sexual o contenido sexual con menores, incluidos código, texto y procesos que lo faciliten.",
      "Facilitar delitos, fraude, estafas, suplantación, explotación de menores, trata de personas o instrucciones para causar daño físico.",
      "Malware, ransomware, phishing, robo de credenciales, código destructivo o herramientas de acceso no autorizado. Las pruebas de seguridad requieren permiso del propietario del sistema.",
      "Recopilar, revelar o abusar sin autorización de datos personales, archivos confidenciales, credenciales o comunicaciones privadas; doxxing, acecho o vigilancia ilegal.",
      "Acoso dirigido, amenazas, odio, spam engañoso o infracciones de propiedad intelectual y otros derechos.",
      "Eludir controles de seguridad o acceso, o disfrazar actividades prohibidas cambiando motor, paso o formato."
    ],
    "reviewTitle": "Revisión y responsabilidad",
    "review": "Eres responsable de las entradas, permisos, ejecución y uso o difusión de resultados. Revisa seguridad, exactitud, privacidad y derechos antes de ejecutar o publicar. La IA puede producir errores o resultados inseguros. Configurar un proceso no concede autorización de acceso o publicación.",
    "reportsTitle": "Denuncias y servicios oficiales",
    "reports": "Comunica posibles abusos al soporte indicado abajo con una breve descripción y un enlace público disponible. No envíes documentos de identidad, domicilios, contraseñas, claves API, conversaciones ni archivos de proyectos privados. Oculta los datos personales.",
    "services": "WorkStep puede restringir o suspender servicios oficiales por incumplimiento según la ley. Esto no implica supervisión centralizada de procesos locales ni detección de todos los abusos. Apache License 2.0 sigue vigente; esta política no modifica la licencia ni los derechos otorgados."
  },
  "pt-BR": {
    "title": "Política de uso aceitável",
    "intro": "Esta política abrange os processos de IA e serviços oficiais do WorkStep, comandos, código e texto gerados, outros resultados e sua distribuição. Use somente dados, projetos, ferramentas e contas autorizados; cumpra a lei e os termos e políticas de segurança dos provedores conectados.",
    "prohibitedTitle": "Usos proibidos",
    "prohibited": [
      "Criar, transformar ou distribuir pornografia, conteúdo sexual explícito ou NSFW, exploração sexual ou conteúdo sexual com menores, incluindo código, texto e processos que facilitem esses usos.",
      "Facilitar atividades ilegais, fraude, golpes, falsidade de identidade, exploração de menores, tráfico de pessoas ou instruções para causar dano físico.",
      "Malware, ransomware, phishing, roubo de credenciais, código destrutivo ou ferramentas de acesso não autorizado. Testes de segurança exigem autorização do proprietário do sistema.",
      "Coletar, divulgar ou abusar sem permissão de dados pessoais, arquivos confidenciais, credenciais ou comunicações privadas; exposição de identidade, perseguição ou vigilância ilegal.",
      "Assédio direcionado, ameaças, ódio, spam enganoso ou violações de propriedade intelectual e outros direitos.",
      "Burlar controles de segurança ou acesso, ou disfarçar atividades proibidas mudando motor, etapa ou formato."
    ],
    "reviewTitle": "Revisão e responsabilidade",
    "review": "Você é responsável pelas entradas, permissões, execução e uso ou compartilhamento dos resultados. Revise segurança, precisão, privacidade e direitos antes de executar ou publicar. Resultados de IA podem estar incorretos ou ser inseguros. Configurar um processo não concede autorização de acesso ou publicação.",
    "reportsTitle": "Denúncias e serviços oficiais",
    "reports": "Relate suspeitas de abuso ao suporte abaixo com uma breve descrição e um link público disponível. Não envie documentos de identidade, endereços residenciais, senhas, chaves API, conversas ou arquivos de projetos privados. Oculte dados pessoais.",
    "services": "O WorkStep pode restringir ou suspender serviços oficiais por violações conforme a lei. Isso não significa monitoramento central dos processos locais nem detecção de todos os abusos. Apache License 2.0 continua aplicável; esta política não modifica a licença nem os direitos concedidos."
  },
  "sv-SE": {
    "title": "Policy för godtagbar användning",
    "intro": "Policyn omfattar WorkSteps AI-processer och officiella tjänster, instruktioner, genererad kod och text, andra resultat och distribution. Använd endast tillåtna data, projekt, verktyg och konton och följ lagar samt anslutna leverantörers villkor och säkerhetsregler.",
    "prohibitedTitle": "Förbjuden användning",
    "prohibited": [
      "Skapa, omvandla eller sprida pornografi, sexuellt explicita eller NSFW-innehåll, sexuellt utnyttjande eller sexuellt innehåll med minderåriga, inklusive kod, text och processer som underlättar detta.",
      "Främja olaglig verksamhet, bedrägeri, bluffar, identitetsmissbruk, utnyttjande av barn, människohandel eller instruktioner för fysisk skada.",
      "Skadlig kod, utpressningsprogram, nätfiske, stöld av inloggningsuppgifter, destruktiv kod eller obehörig åtkomst. Säkerhetstester kräver systemägarens tillstånd.",
      "Obehörig insamling, spridning eller missbruk av personuppgifter, hemliga filer, inloggningsuppgifter eller privat kommunikation; uthängning, förföljelse eller olaglig övervakning.",
      "Riktade trakasserier, hot, hat, vilseledande skräppost eller intrång i immateriella eller andra rättigheter.",
      "Kringgå leverantörers säkerhets- eller åtkomstkontroller eller dölja förbjuden aktivitet genom annan motor, annat steg eller format."
    ],
    "reviewTitle": "Granskning och ansvar",
    "review": "Du ansvarar för indata, behörigheter, körning och användning eller delning av resultat. Granska säkerhet, riktighet, integritet och rättigheter före körning eller publicering. AI-resultat kan vara felaktiga eller osäkra. En konfiguration ger inte tillstånd till åtkomst eller publicering.",
    "reportsTitle": "Rapporter och officiella tjänster",
    "reports": "Rapportera misstänkt missbruk till supporten nedan med kort beskrivning och eventuell offentlig länk. Skicka inte ID-handlingar, hemadresser, lösenord, API-nycklar, privata samtal eller projektfiler. Maskera personuppgifter.",
    "services": "WorkStep kan enligt lag begränsa eller pausa officiella tjänster vid överträdelser. Det innebär inte central övervakning av lokala processer eller upptäckt av alla överträdelser. Apache License 2.0 gäller fortsatt; policyn ändrar inte licensen eller beviljade rättigheter."
  },
  "da-DK": {
    "title": "Politik for acceptabel brug",
    "intro": "Politikken omfatter WorkSteps AI-processer og officielle tjenester, instruktioner, genereret kode og tekst, andre resultater og distribution. Brug kun tilladte data, projekter, værktøjer og konti, og følg loven samt tilsluttede leverandørers vilkår og sikkerhedspolitikker.",
    "prohibitedTitle": "Forbudt brug",
    "prohibited": [
      "Skabe, ændre eller distribuere pornografi, seksuelt eksplicit eller NSFW-indhold, seksuel udnyttelse eller seksuelt indhold med mindreårige, herunder kode, tekst og processer, der fremmer det.",
      "Fremme ulovlig aktivitet, svindel, bedrageri, identitetsmisbrug, udnyttelse af børn, menneskehandel eller anvisninger til fysisk skade.",
      "Malware, ransomware, phishing, tyveri af loginoplysninger, destruktiv kode eller uautoriseret adgang. Sikkerhedstest kræver systemejerens tilladelse.",
      "Uautoriseret indsamling, offentliggørelse eller misbrug af persondata, fortrolige filer, loginoplysninger eller privat kommunikation; doxxing, stalking eller ulovlig overvågning.",
      "Målrettet chikane, trusler, had, vildledende spam eller krænkelse af immaterielle og andre rettigheder.",
      "Omgå leverandørers sikkerheds- eller adgangskontrol eller skjule forbudte aktiviteter gennem andre motorer, trin eller formater."
    ],
    "reviewTitle": "Gennemgang og ansvar",
    "review": "Du er ansvarlig for input, tilladelser, udførelse og brug eller deling af resultater. Kontrollér sikkerhed, nøjagtighed, privatliv og rettigheder før kørsel eller publicering. AI-resultater kan være forkerte eller usikre. Konfiguration giver ikke adgangs- eller publiceringstilladelse.",
    "reportsTitle": "Indberetninger og officielle tjenester",
    "reports": "Indberet mistænkt misbrug til supporten nedenfor med en kort beskrivelse og eventuelt offentligt link. Send ikke ID, hjemmeadresser, adgangskoder, API-nøgler, private samtaler eller projektfiler. Fjern personoplysninger fra bilag.",
    "services": "WorkStep kan lovligt begrænse eller suspendere officielle tjenester ved overtrædelser. Det indebærer ikke central overvågning af lokale processer eller registrering af alle overtrædelser. Apache License 2.0 gælder fortsat; politikken ændrer ikke licensen eller de tildelte rettigheder."
  },
  "nb-NO": {
    "title": "Retningslinjer for akseptabel bruk",
    "intro": "Retningslinjene omfatter WorkSteps AI-prosesser og offisielle tjenester, instruksjoner, generert kode og tekst, andre resultater og distribusjon. Bruk bare autoriserte data, prosjekter, verktøy og kontoer, og følg loven samt tilknyttede leverandørers vilkår og sikkerhetsregler.",
    "prohibitedTitle": "Forbudt bruk",
    "prohibited": [
      "Lage, endre eller distribuere pornografi, seksuelt eksplisitt eller NSFW-innhold, seksuell utnyttelse eller seksuelt innhold med mindreårige, inkludert kode, tekst og prosesser som legger til rette for det.",
      "Tilrettelegge for ulovlig aktivitet, bedrageri, svindel, identitetsmisbruk, utnyttelse av barn, menneskehandel eller instruksjoner for fysisk skade.",
      "Skadevare, løsepengevirus, nettfiske, tyveri av påloggingsinformasjon, ødeleggende kode eller uautorisert tilgang. Sikkerhetstester krever systemeierens tillatelse.",
      "Uautorisert innsamling, deling eller misbruk av persondata, fortrolige filer, påloggingsinformasjon eller privat kommunikasjon; doxxing, forfølgelse eller ulovlig overvåkning.",
      "Målrettet trakassering, trusler, hat, villedende spam eller krenkelse av immaterielle og andre rettigheter.",
      "Omgå leverandørers sikkerhets- eller tilgangskontroller eller skjule forbudt aktivitet gjennom andre motorer, trinn eller formater."
    ],
    "reviewTitle": "Gjennomgang og ansvar",
    "review": "Du er ansvarlig for inndata, tillatelser, kjøring og bruk eller deling av resultater. Kontroller sikkerhet, korrekthet, personvern og rettigheter før kjøring eller publisering. AI-resultater kan være feil eller utrygge. Konfigurasjon gir ikke tilgangs- eller publiseringstillatelse.",
    "reportsTitle": "Varsling og offisielle tjenester",
    "reports": "Meld mulig misbruk til støtten nedenfor med kort beskrivelse og eventuell offentlig lenke. Ikke send ID, hjemmeadresse, passord, API-nøkler, private samtaler eller prosjektfiler. Sladd personopplysninger.",
    "services": "WorkStep kan lovlig begrense eller stanse offisielle tjenester ved brudd. Dette innebærer ikke sentral overvåkning av lokale prosesser eller at alle brudd oppdages. Apache License 2.0 gjelder fortsatt; retningslinjene endrer ikke lisensen eller innvilgede rettigheter."
  },
  "fi-FI": {
    "title": "Hyväksyttävän käytön käytäntö",
    "intro": "Käytäntö koskee WorkStepin AI-prosesseja ja virallisia palveluita, kehotteita, luotua koodia ja tekstiä, muita tuloksia ja jakelua. Käytä vain luvallisia tietoja, projekteja, työkaluja ja tilejä sekä noudata lakeja ja yhdistettyjen tarjoajien ehtoja ja turvallisuusohjeita.",
    "prohibitedTitle": "Kielletty käyttö",
    "prohibited": [
      "Pornografian, seksuaalisesti yksityiskohtaisen tai NSFW-sisällön, seksuaalisen hyväksikäytön tai alaikäisiä koskevan seksuaalisen sisällön luominen, muokkaaminen tai jakelu, myös sitä edistävä koodi, teksti ja prosessit.",
      "Laittoman toiminnan, petosten, huijausten, toisena esiintymisen, lasten hyväksikäytön, ihmiskaupan tai fyysiseen vahinkoon tähtäävien ohjeiden edistäminen.",
      "Haittaohjelmat, kiristysohjelmat, tietojenkalastelu, tunnusten varkaus, tuhoava koodi tai luvaton pääsy. Turvatestaus vaatii järjestelmän omistajan luvan.",
      "Henkilötietojen, luottamuksellisten tiedostojen, tunnusten tai yksityisviestien luvaton keruu, paljastaminen tai väärinkäyttö; tietojen levittäminen, vaino tai laiton valvonta.",
      "Kohdennettu häirintä, uhkaukset, viha, harhaanjohtava roskaposti tai immateriaali- ja muiden oikeuksien loukkaus.",
      "Tarjoajien turva- tai pääsyrajoitusten kiertäminen tai kielletyn toiminnan peittäminen vaihtamalla moottoria, vaihetta tai muotoa."
    ],
    "reviewTitle": "Tarkistus ja vastuu",
    "review": "Vastaat syötteistä, luvista, suorituksesta sekä tulosten käytöstä ja jakamisesta. Tarkista turvallisuus, oikeellisuus, yksityisyys ja oikeudet ennen ajoa tai julkaisua. AI-tulokset voivat olla virheellisiä tai vaarallisia. Asetukset eivät myönnä pääsy- tai julkaisulupaa.",
    "reportsTitle": "Ilmoitukset ja viralliset palvelut",
    "reports": "Ilmoita epäillystä väärinkäytöstä alla olevaan tukeen lyhyellä kuvauksella ja saatavilla olevalla julkisella linkillä. Älä lähetä henkilöllisyystodistuksia, kotiosoitteita, salasanoja, API-avaimia, yksityisviestejä tai projektitiedostoja. Peitä henkilötiedot.",
    "services": "WorkStep voi lain mukaan rajoittaa tai keskeyttää viralliset palvelut rikkomuksista. Tämä ei tarkoita paikallisten prosessien keskitettyä valvontaa tai kaikkien rikkomusten tunnistamista. Apache License 2.0 pysyy voimassa; käytäntö ei muuta lisenssiä tai myönnettyjä oikeuksia."
  },
  "cs-CZ": {
    "title": "Zásady přijatelného používání",
    "intro": "Zásady se vztahují na procesy AI a oficiální služby WorkStep, zadání, generovaný kód a text, další výstupy a jejich šíření. Používejte jen oprávněná data, projekty, nástroje a účty a dodržujte zákony, podmínky a bezpečnostní zásady připojených poskytovatelů.",
    "prohibitedTitle": "Zakázané použití",
    "prohibited": [
      "Tvorba, úprava či šíření pornografie, sexuálně explicitního nebo NSFW obsahu, sexuálního vykořisťování či sexuálního obsahu s nezletilými, včetně podpůrného kódu, textu a procesů.",
      "Podpora nezákonné činnosti, podvodů, klamání, vydávání se za jiné, zneužívání dětí, obchodování s lidmi nebo návodů k fyzické újmě.",
      "Malware, ransomware, phishing, krádež přihlašovacích údajů, ničivý kód či nástroje neoprávněného přístupu. Bezpečnostní testy vyžadují souhlas vlastníka systému.",
      "Neoprávněný sběr, zveřejnění či zneužití osobních dat, důvěrných souborů, přístupových údajů či soukromé komunikace; doxxing, pronásledování či nezákonné sledování.",
      "Cílené obtěžování, výhrůžky, nenávist, klamavý spam či porušování duševního vlastnictví a dalších práv.",
      "Obcházení bezpečnostních či přístupových kontrol nebo skrývání zakázané činnosti změnou enginu, kroku či formátu."
    ],
    "reviewTitle": "Kontrola a odpovědnost",
    "review": "Odpovídáte za vstupy, oprávnění, spuštění a použití či sdílení výstupů. Před spuštěním nebo publikováním zkontrolujte bezpečnost, přesnost, soukromí a práva. AI může vytvářet chybné nebo nebezpečné výstupy. Konfigurace neuděluje oprávnění k přístupu či publikaci.",
    "reportsTitle": "Hlášení a oficiální služby",
    "reports": "Podezření na zneužití hlaste podpoře níže s krátkým popisem a dostupným veřejným odkazem. Neposílejte doklady, domácí adresy, hesla, klíče API, soukromé rozhovory ani soubory projektů. Osobní údaje anonymizujte.",
    "services": "WorkStep může v souladu se zákonem omezit či pozastavit oficiální služby při porušení zásad. Nejde o centrální dohled nad místními procesy ani záruku odhalení všech porušení. Apache License 2.0 platí nadále; zásady nemění licenci ani udělená práva."
  },
  "el-GR": {
    "title": "Πολιτική αποδεκτής χρήσης",
    "intro": "Η πολιτική καλύπτει τις διαδικασίες AI και τις επίσημες υπηρεσίες του WorkStep, οδηγίες, παραγόμενο κώδικα και κείμενο, άλλα αποτελέσματα και διανομή. Χρησιμοποιείτε μόνο εξουσιοδοτημένα δεδομένα, έργα, εργαλεία και λογαριασμούς και τηρείτε νόμους, όρους και πολιτικές ασφάλειας των συνδεδεμένων παρόχων.",
    "prohibitedTitle": "Απαγορευμένες χρήσεις",
    "prohibited": [
      "Δημιουργία, μετατροπή ή διανομή πορνογραφίας, σεξουαλικά ρητού ή NSFW περιεχομένου, σεξουαλικής εκμετάλλευσης ή σεξουαλικού περιεχομένου με ανηλίκους, καθώς και υποστηρικτικού κώδικα, κειμένου και διαδικασιών.",
      "Διευκόλυνση παράνομων πράξεων, απάτης, εξαπάτησης, πλαστοπροσωπίας, εκμετάλλευσης ανηλίκων, εμπορίας ανθρώπων ή οδηγιών σωματικής βλάβης.",
      "Κακόβουλο λογισμικό, ransomware, phishing, κλοπή διαπιστευτηρίων, καταστροφικός κώδικας ή μη εξουσιοδοτημένη πρόσβαση. Οι δοκιμές ασφαλείας απαιτούν άδεια του ιδιοκτήτη του συστήματος.",
      "Μη εξουσιοδοτημένη συλλογή, αποκάλυψη ή κατάχρηση προσωπικών δεδομένων, εμπιστευτικών αρχείων, διαπιστευτηρίων ή ιδιωτικών επικοινωνιών· δημοσιοποίηση ταυτότητας, παρενόχληση με παρακολούθηση ή παράνομη επιτήρηση.",
      "Στοχευμένη παρενόχληση, απειλές, μίσος, παραπλανητικό spam ή παραβίαση πνευματικών και άλλων δικαιωμάτων.",
      "Παράκαμψη ελέγχων ασφάλειας ή πρόσβασης ή απόκρυψη απαγορευμένων πράξεων με αλλαγή μηχανής, βήματος ή μορφής."
    ],
    "reviewTitle": "Έλεγχος και ευθύνη",
    "review": "Ευθύνεστε για εισόδους, άδειες, εκτέλεση και χρήση ή κοινοποίηση αποτελεσμάτων. Ελέγχετε ασφάλεια, ακρίβεια, ιδιωτικότητα και δικαιώματα πριν από εκτέλεση ή δημοσίευση. Τα αποτελέσματα AI μπορεί να είναι εσφαλμένα ή μη ασφαλή. Η ρύθμιση δεν παρέχει άδεια πρόσβασης ή δημοσίευσης.",
    "reportsTitle": "Αναφορές και επίσημες υπηρεσίες",
    "reports": "Αναφέρετε πιθανή κατάχρηση στην παρακάτω υποστήριξη με σύντομη περιγραφή και διαθέσιμο δημόσιο σύνδεσμο. Μην στέλνετε ταυτότητες, διευθύνσεις κατοικίας, κωδικούς, κλειδιά API, ιδιωτικές συνομιλίες ή αρχεία έργων. Αποκρύψτε προσωπικά δεδομένα.",
    "services": "Το WorkStep μπορεί νόμιμα να περιορίσει ή να αναστείλει επίσημες υπηρεσίες για παραβάσεις. Αυτό δεν σημαίνει κεντρική παρακολούθηση τοπικών διαδικασιών ή εντοπισμό όλων των παραβάσεων. Η Apache License 2.0 παραμένει σε ισχύ· η πολιτική δεν αλλάζει την άδεια ή τα παραχωρημένα δικαιώματα."
  },
  "he-IL": {
    "title": "מדיניות שימוש מקובל",
    "intro": "המדיניות חלה על תהליכי ה-AI והשירותים הרשמיים של WorkStep, הנחיות, קוד וטקסט שנוצרו, תוצרים נוספים והפצתם. השתמשו רק בנתונים, פרויקטים, כלים וחשבונות מורשים, ופעלו לפי הדין ותנאי ומדיניות הבטיחות של הספקים המחוברים.",
    "prohibitedTitle": "שימושים אסורים",
    "prohibited": [
      "יצירה, שינוי או הפצה של פורנוגרפיה, תוכן מיני מפורש או NSFW, ניצול מיני או תוכן מיני עם קטינים, לרבות קוד, טקסט ותהליכים המאפשרים זאת.",
      "סיוע לפעילות לא חוקית, הונאה, תרמית, התחזות, ניצול קטינים, סחר בבני אדם או הוראות לגרימת פגיעה גופנית.",
      "נוזקות, כופרות, דיוג, גניבת פרטי גישה, קוד הרסני או כלים לגישה בלתי מורשית. בדיקות אבטחה מחייבות אישור מבעל המערכת.",
      "איסוף, חשיפה או ניצול ללא אישור של מידע אישי, קבצים חסויים, פרטי גישה או תקשורת פרטית; חשיפת זהות, הטרדה עוקבת או מעקב לא חוקי.",
      "הטרדה ממוקדת, איומים, שנאה, ספאם מטעה או הפרת קניין רוחני וזכויות אחרות.",
      "עקיפת בקרות הבטיחות או הגישה של ספקים, או הסתרת פעילות אסורה באמצעות החלפת מנוע, שלב או פורמט."
    ],
    "reviewTitle": "בדיקה ואחריות",
    "review": "האחריות לקלטים, הרשאות, הפעלה ושימוש או שיתוף בתוצרים היא שלכם. לפני הרצה או פרסום בדקו בטיחות, דיוק, פרטיות וזכויות. תוצרי AI עלולים להיות שגויים או לא בטוחים. הגדרה אינה מעניקה רשות גישה או פרסום.",
    "reportsTitle": "דיווח ושירותים רשמיים",
    "reports": "דווחו על חשד לניצול לרעה לתמיכה להלן, עם תיאור קצר וקישור ציבורי אם קיים. אין לשלוח מסמכי זהות, כתובות בית, סיסמאות, מפתחות API, שיחות או קובצי פרויקט פרטיים. השחירו מידע אישי בחומרי הראיות.",
    "services": "WorkStep עשוי להגביל או להשעות שירותים רשמיים עקב הפרות בהתאם לדין. אין בכך טענה לניטור מרכזי של תהליכים מקומיים או לגילוי כל הפרה. Apache License 2.0 נותר בתוקף; המדיניות אינה משנה את הרישיון או את הזכויות שהוא מעניק."
  },
  "ar": {
    "title": "سياسة الاستخدام المقبول",
    "intro": "تشمل السياسة عمليات الذكاء الاصطناعي وخدمات WorkStep الرسمية، والتعليمات والشيفرة والنصوص والمخرجات الأخرى وتوزيعها. استخدم فقط البيانات والمشاريع والأدوات والحسابات المصرح بها، والتزم بالقوانين وشروط وسياسات سلامة المزودين المتصلين.",
    "prohibitedTitle": "الاستخدامات المحظورة",
    "prohibited": [
      "إنشاء أو تحويل أو نشر مواد إباحية أو جنسية صريحة أو NSFW أو استغلال جنسي أو محتوى جنسي يشمل قاصرين، بما في ذلك الشيفرة والنصوص والعمليات التي تسهّل ذلك.",
      "تسهيل أنشطة غير قانونية أو احتيال أو خداع أو انتحال هوية أو استغلال قاصرين أو اتجار بالبشر أو تعليمات تهدف إلى إحداث أذى جسدي.",
      "البرمجيات الخبيثة وبرمجيات الفدية والتصيد وسرقة بيانات الاعتماد والشيفرة التخريبية وأدوات الوصول غير المصرح به. تتطلب اختبارات الأمن إذن مالك النظام.",
      "جمع أو كشف أو إساءة استخدام بيانات شخصية أو ملفات سرية أو بيانات اعتماد أو اتصالات خاصة دون إذن؛ كشف الهوية أو الملاحقة أو المراقبة غير القانونية.",
      "المضايقة المستهدفة أو التهديدات أو الكراهية أو الرسائل المزعجة المخادعة أو انتهاك الملكية الفكرية والحقوق الأخرى.",
      "تجاوز ضوابط السلامة أو الوصول لدى المزودين، أو إخفاء نشاط محظور بتغيير المحرك أو الخطوة أو تنسيق المخرجات."
    ],
    "reviewTitle": "المراجعة والمسؤولية",
    "review": "أنت مسؤول عن المدخلات والأذونات والتنفيذ واستخدام المخرجات أو مشاركتها. راجع السلامة والدقة والخصوصية والحقوق قبل التشغيل أو النشر. قد تكون مخرجات الذكاء الاصطناعي خاطئة أو غير آمنة. الإعداد لا يمنح إذن وصول أو نشر.",
    "reportsTitle": "الإبلاغ والخدمات الرسمية",
    "reports": "أبلغ الدعم أدناه عن إساءة الاستخدام المشتبه بها بوصف مختصر ورابط عام متاح. لا ترسل وثائق هوية أو عناوين منزلية أو كلمات مرور أو مفاتيح API أو محادثات أو ملفات مشاريع خاصة. احجب المعلومات الشخصية من الأدلة.",
    "services": "يجوز لـ WorkStep تقييد الخدمات الرسمية أو تعليقها بسبب المخالفات وفق القانون. لا يعني ذلك مراقبة مركزية للعمليات المحلية أو اكتشاف جميع المخالفات. تظل Apache License 2.0 سارية؛ لا تعدّل السياسة الترخيص أو الحقوق الممنوحة."
  },
  "th-TH": {
    "title": "นโยบายการใช้งานที่ยอมรับได้",
    "intro": "นโยบายนี้ครอบคลุมกระบวนการ AI และบริการทางการของ WorkStep พรอมป์ต์ โค้ดและข้อความที่สร้าง ผลลัพธ์อื่นและการเผยแพร่ ใช้เฉพาะข้อมูล โครงการ เครื่องมือและบัญชีที่ได้รับอนุญาต และปฏิบัติตามกฎหมาย ข้อกำหนดและนโยบายความปลอดภัยของผู้ให้บริการที่เชื่อมต่อ",
    "prohibitedTitle": "การใช้งานที่ห้าม",
    "prohibited": [
      "สร้าง ดัดแปลงหรือเผยแพร่สื่อลามก เนื้อหาทางเพศชัดเจนหรือ NSFW การแสวงหาประโยชน์ทางเพศ หรือเนื้อหาทางเพศเกี่ยวกับผู้เยาว์ รวมถึงโค้ด ข้อความและกระบวนการที่ช่วยให้เกิดเนื้อหาเหล่านี้",
      "สนับสนุนกิจกรรมผิดกฎหมาย การฉ้อโกง การหลอกลวง การสวมรอย การแสวงหาประโยชน์จากเด็ก การค้ามนุษย์ หรือคำแนะนำเพื่อทำร้ายร่างกาย",
      "มัลแวร์ แรนซัมแวร์ ฟิชชิง การขโมยข้อมูลรับรอง โค้ดทำลาย หรือเครื่องมือเข้าถึงโดยไม่ได้รับอนุญาต การทดสอบความปลอดภัยต้องได้รับอนุญาตจากเจ้าของระบบ",
      "เก็บ เปิดเผยหรือใช้ข้อมูลส่วนบุคคล ไฟล์ลับ ข้อมูลรับรองหรือการสื่อสารส่วนตัวโดยไม่ได้รับอนุญาต การเปิดเผยตัวตน การสะกดรอยหรือเฝ้าระวังผิดกฎหมาย",
      "คุกคามแบบเจาะจง ข่มขู่ แสดงความเกลียดชัง ส่งสแปมหลอกลวง หรือละเมิดทรัพย์สินทางปัญญาและสิทธิอื่น",
      "ข้ามระบบความปลอดภัยหรือข้อจำกัดการเข้าถึงของผู้ให้บริการ หรือปกปิดกิจกรรมต้องห้ามด้วยการเปลี่ยนเอนจิน ขั้นตอนหรือรูปแบบผลลัพธ์"
    ],
    "reviewTitle": "การตรวจสอบและความรับผิดชอบ",
    "review": "คุณรับผิดชอบอินพุต สิทธิ์ การทำงาน และการใช้หรือแชร์ผลลัพธ์ ตรวจสอบความปลอดภัย ความถูกต้อง ความเป็นส่วนตัวและสิทธิก่อนเรียกใช้หรือเผยแพร่ ผลลัพธ์ AI อาจผิดหรือไม่ปลอดภัย การตั้งค่าไม่ได้ให้สิทธิ์เข้าถึงหรือเผยแพร่",
    "reportsTitle": "การรายงานและบริการทางการ",
    "reports": "รายงานการใช้งานที่น่าสงสัยต่อฝ่ายสนับสนุนด้านล่าง พร้อมคำอธิบายสั้นและลิงก์สาธารณะถ้ามี อย่าส่งเอกสารระบุตัวตน ที่อยู่บ้าน รหัสผ่าน คีย์ API บทสนทนาหรือไฟล์โครงการส่วนตัว ปกปิดข้อมูลส่วนบุคคลในหลักฐานก่อน",
    "services": "WorkStep อาจจำกัดหรือระงับบริการทางการเมื่อมีการละเมิดตามกฎหมาย ไม่ได้หมายถึงการเฝ้าดูกระบวนการในเครื่องจากศูนย์กลางหรือรับรองว่าจะตรวจพบทุกการละเมิด Apache License 2.0 ยังคงใช้บังคับ นโยบายนี้ไม่แก้ไขใบอนุญาตหรือสิทธิที่ได้รับ"
  }
}
