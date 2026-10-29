// memo-auto-labels.js — ML Kit's base image-labeling vocabulary, localized,
// and the smart-album groupings built on it. Ported from ImageDB's
// auto-labels.js (same label indices, names and album definitions). Labels are
// stored by their stable model index, so search and display work in every UI
// language. Memora works per image: an entry is in an album when one of its
// images is.
(function (global) {
  'use strict';

  // [index, en, es, fr, de, pt, nl, zh, ja]
  const AUTO_LABEL_ROWS = [
    [0, "Team", "Equipo", "Équipe", "Team", "Equipe", "Team", "团队", "チーム"],
    [1, "Bonfire", "Hoguera", "Feu de joie", "Lagerfeuer", "Fogueira", "Kampvuur", "篝火", "焚き火"],
    [2, "Comics", "Cómics", "Bande dessinée", "Comics", "Quadrinhos", "Strips", "漫画", "コミック"],
    [3, "Himalayan cat", "Gato himalayo", "Chat himalayen", "Himalaya-Katze", "Gato himalaio", "Himalayakat", "喜马拉雅猫", "ヒマラヤン"],
    [4, "Iceberg", "Iceberg", "Iceberg", "Eisberg", "Iceberg", "IJsberg", "冰山", "氷山"],
    [5, "Bento", "Bento", "Bento", "Bento", "Bentô", "Bento", "便当", "弁当"],
    [7, "Sink", "Fregadero", "Évier", "Waschbecken", "Pia", "Gootsteen", "水槽", "シンク"],
    [8, "Toy", "Juguete", "Jouet", "Spielzeug", "Brinquedo", "Speelgoed", "玩具", "おもちゃ"],
    [9, "Statue", "Estatua", "Statue", "Statue", "Estátua", "Standbeeld", "雕像", "彫像"],
    [10, "Cheeseburger", "Hamburguesa con queso", "Cheeseburger", "Cheeseburger", "Cheeseburger", "Cheeseburger", "芝士汉堡", "チーズバーガー"],
    [11, "Tractor", "Tractor", "Tracteur", "Traktor", "Trator", "Tractor", "拖拉机", "トラクター"],
    [12, "Sled", "Trineo", "Luge", "Schlitten", "Trenó", "Slee", "雪橇", "そり"],
    [13, "Aquarium", "Acuario", "Aquarium", "Aquarium", "Aquário", "Aquarium", "水族馆", "水族館"],
    [14, "Circus", "Circo", "Cirque", "Zirkus", "Circo", "Circus", "马戏团", "サーカス"],
    [16, "Sitting", "Sentado", "Assis", "Sitzen", "Sentado", "Zitten", "坐着", "座っている"],
    [17, "Beard", "Barba", "Barbe", "Bart", "Barba", "Baard", "胡子", "ひげ"],
    [18, "Bridge", "Puente", "Pont", "Brücke", "Ponte", "Brug", "桥", "橋"],
    [19, "Tights", "Medias", "Collants", "Strumpfhose", "Meia-calça", "Panty", "连裤袜", "タイツ"],
    [20, "Bird", "Pájaro", "Oiseau", "Vogel", "Pássaro", "Vogel", "鸟", "鳥"],
    [21, "Rafting", "Rafting", "Rafting", "Rafting", "Rafting", "Raften", "漂流", "ラフティング"],
    [22, "Park", "Parque", "Parc", "Park", "Parque", "Park", "公园", "公園"],
    [24, "Factory", "Fábrica", "Usine", "Fabrik", "Fábrica", "Fabriek", "工厂", "工場"],
    [25, "Graduation", "Graduación", "Remise de diplômes", "Abschlussfeier", "Formatura", "Diploma-uitreiking", "毕业", "卒業"],
    [26, "Porcelain", "Porcelana", "Porcelaine", "Porzellan", "Porcelana", "Porselein", "瓷器", "磁器"],
    [27, "Twig", "Ramita", "Brindille", "Zweig", "Graveto", "Twijg", "细枝", "小枝"],
    [28, "Petal", "Pétalo", "Pétale", "Blütenblatt", "Pétala", "Bloemblad", "花瓣", "花びら"],
    [29, "Cushion", "Cojín", "Coussin", "Kissen", "Almofada", "Kussen", "靠垫", "クッション"],
    [30, "Sunglasses", "Gafas de sol", "Lunettes de soleil", "Sonnenbrille", "Óculos de sol", "Zonnebril", "太阳镜", "サングラス"],
    [31, "Infrastructure", "Infraestructura", "Infrastructure", "Infrastruktur", "Infraestrutura", "Infrastructuur", "基础设施", "インフラ"],
    [32, "Ferris wheel", "Noria", "Grande roue", "Riesenrad", "Roda-gigante", "Reuzenrad", "摩天轮", "観覧車"],
    [33, "Damselfish", "Pez damisela", "Poisson demoiselle", "Riffbarsch", "Peixe-donzela", "Rifbaars", "雀鲷", "スズメダイ"],
    [34, "Wetsuit", "Traje de neopreno", "Combinaison de plongée", "Neoprenanzug", "Roupa de neoprene", "Wetsuit", "潜水服", "ウェットスーツ"],
    [35, "Shetland sheepdog", "Pastor de Shetland", "Berger des Shetland", "Sheltie", "Pastor de Shetland", "Shetland-herder", "喜乐蒂牧羊犬", "シェットランド・シープドッグ"],
    [36, "Brig", "Bergantín", "Brick", "Brigg", "Brigue", "Brik", "双桅帆船", "ブリッグ"],
    [37, "Watercolor", "Acuarela", "Aquarelle", "Aquarell", "Aquarela", "Aquarel", "水彩", "水彩画"],
    [38, "Competition", "Competición", "Compétition", "Wettkampf", "Competição", "Wedstrijd", "比赛", "競技"],
    [39, "Cliff", "Acantilado", "Falaise", "Klippe", "Penhasco", "Klif", "悬崖", "崖"],
    [40, "Badminton", "Bádminton", "Badminton", "Badminton", "Badminton", "Badminton", "羽毛球", "バドミントン"],
    [41, "Safari", "Safari", "Safari", "Safari", "Safári", "Safari", "野生动物园", "サファリ"],
    [42, "Bicycle", "Bicicleta", "Vélo", "Fahrrad", "Bicicleta", "Fiets", "自行车", "自転車"],
    [43, "Stadium", "Estadio", "Stade", "Stadion", "Estádio", "Stadion", "体育场", "スタジアム"],
    [45, "Boat", "Barco", "Bateau", "Boot", "Barco", "Boot", "船", "ボート"],
    [46, "Smile", "Sonrisa", "Sourire", "Lächeln", "Sorriso", "Glimlach", "微笑", "笑顔"],
    [47, "Surfboard", "Tabla de surf", "Planche de surf", "Surfbrett", "Prancha de surfe", "Surfplank", "冲浪板", "サーフボード"],
    [48, "Fast food", "Comida rápida", "Restauration rapide", "Fast Food", "Fast-food", "Fastfood", "快餐", "ファストフード"],
    [49, "Sunset", "Atardecer", "Coucher de soleil", "Sonnenuntergang", "Pôr do sol", "Zonsondergang", "日落", "夕日"],
    [50, "Hot dog", "Perrito caliente", "Hot-dog", "Hotdog", "Cachorro-quente", "Hotdog", "热狗", "ホットドッグ"],
    [51, "Shorts", "Pantalón corto", "Short", "Shorts", "Bermuda", "Korte broek", "短裤", "ショートパンツ"],
    [52, "Bus", "Autobús", "Bus", "Bus", "Ônibus", "Bus", "公交车", "バス"],
    [53, "Bullfighting", "Tauromaquia", "Corrida", "Stierkampf", "Tourada", "Stierengevecht", "斗牛", "闘牛"],
    [54, "Sky", "Cielo", "Ciel", "Himmel", "Céu", "Lucht", "天空", "空"],
    [55, "Gerbil", "Jerbo", "Gerbille", "Rennmaus", "Gerbil", "Gerbil", "沙鼠", "スナネズミ"],
    [56, "Rock", "Roca", "Rocher", "Fels", "Rocha", "Rots", "岩石", "岩"],
    [57, "Interaction", "Interacción", "Interaction", "Interaktion", "Interação", "Interactie", "互动", "交流"],
    [58, "Dress", "Vestido", "Robe", "Kleid", "Vestido", "Jurk", "连衣裙", "ドレス"],
    [59, "Toe", "Dedo del pie", "Orteil", "Zeh", "Dedo do pé", "Teen", "脚趾", "つま先"],
    [61, "Bear", "Oso", "Ours", "Bär", "Urso", "Beer", "熊", "クマ"],
    [62, "Eating", "Comiendo", "Repas", "Essen", "Comendo", "Eten", "吃饭", "食事中"],
    [63, "Tower", "Torre", "Tour", "Turm", "Torre", "Toren", "塔", "塔"],
    [64, "Brick", "Ladrillo", "Brique", "Ziegel", "Tijolo", "Baksteen", "砖", "レンガ"],
    [65, "Junk", "Chatarra", "Bric-à-brac", "Gerümpel", "Sucata", "Rommel", "杂物", "がらくた"],
    [66, "Person", "Persona", "Personne", "Person", "Pessoa", "Persoon", "人", "人物"],
    [67, "Windsurfing", "Windsurf", "Planche à voile", "Windsurfen", "Windsurfe", "Windsurfen", "风帆冲浪", "ウィンドサーフィン"],
    [68, "Swimwear", "Bañador", "Maillot de bain", "Badebekleidung", "Roupa de banho", "Badkleding", "泳装", "水着"],
    [69, "Roller", "Rodillo", "Rouleau", "Rolle", "Rolo", "Roller", "滚轮", "ローラー"],
    [70, "Camping", "Acampada", "Camping", "Camping", "Acampamento", "Kamperen", "露营", "キャンプ"],
    [71, "Playground", "Parque infantil", "Aire de jeux", "Spielplatz", "Parquinho", "Speeltuin", "游乐场", "遊び場"],
    [72, "Bathroom", "Baño", "Salle de bain", "Badezimmer", "Banheiro", "Badkamer", "浴室", "浴室"],
    [73, "Laugh", "Risa", "Rire", "Lachen", "Risada", "Lach", "大笑", "笑い"],
    [74, "Balloon", "Globo", "Ballon", "Luftballon", "Balão", "Ballon", "气球", "風船"],
    [75, "Concert", "Concierto", "Concert", "Konzert", "Show", "Concert", "音乐会", "コンサート"],
    [76, "Prom", "Baile de graduación", "Bal de promo", "Abschlussball", "Baile de formatura", "Gala", "毕业舞会", "プロム"],
    [77, "Construction", "Construcción", "Chantier", "Baustelle", "Construção", "Bouw", "施工", "工事"],
    [78, "Product", "Producto", "Produit", "Produkt", "Produto", "Product", "产品", "製品"],
    [79, "Reef", "Arrecife", "Récif", "Riff", "Recife", "Rif", "礁石", "サンゴ礁"],
    [80, "Picnic", "Pícnic", "Pique-nique", "Picknick", "Piquenique", "Picknick", "野餐", "ピクニック"],
    [81, "Wreath", "Corona de flores", "Couronne", "Kranz", "Guirlanda", "Krans", "花环", "リース"],
    [82, "Wheelbarrow", "Carretilla", "Brouette", "Schubkarre", "Carrinho de mão", "Kruiwagen", "手推车", "手押し車"],
    [83, "Boxer", "Bóxer", "Boxer", "Boxer", "Boxer", "Boxer", "拳师犬", "ボクサー"],
    [84, "Necklace", "Collar", "Collier", "Halskette", "Colar", "Ketting", "项链", "ネックレス"],
    [85, "Bracelet", "Pulsera", "Bracelet", "Armband", "Pulseira", "Armband", "手链", "ブレスレット"],
    [86, "Casino", "Casino", "Casino", "Casino", "Cassino", "Casino", "赌场", "カジノ"],
    [87, "Windshield", "Parabrisas", "Pare-brise", "Windschutzscheibe", "Para-brisa", "Voorruit", "挡风玻璃", "フロントガラス"],
    [88, "Stairs", "Escaleras", "Escalier", "Treppe", "Escada", "Trap", "楼梯", "階段"],
    [89, "Computer", "Ordenador", "Ordinateur", "Computer", "Computador", "Computer", "电脑", "コンピューター"],
    [90, "Cookware", "Utensilios de cocina", "Ustensiles de cuisine", "Kochgeschirr", "Utensílios de cozinha", "Kookgerei", "炊具", "調理器具"],
    [91, "Monochrome", "Monocromo", "Monochrome", "Schwarzweiß", "Monocromático", "Zwart-wit", "黑白", "モノクロ"],
    [92, "Chair", "Silla", "Chaise", "Stuhl", "Cadeira", "Stoel", "椅子", "椅子"],
    [93, "Poster", "Póster", "Affiche", "Poster", "Pôster", "Poster", "海报", "ポスター"],
    [94, "Bar", "Bar", "Bar", "Bar", "Bar", "Bar", "酒吧", "バー"],
    [95, "Shipwreck", "Naufragio", "Épave", "Schiffswrack", "Naufrágio", "Scheepswrak", "沉船", "難破船"],
    [96, "Pier", "Muelle", "Jetée", "Pier", "Píer", "Pier", "码头", "桟橋"],
    [97, "Community", "Comunidad", "Communauté", "Gemeinschaft", "Comunidade", "Gemeenschap", "社区", "コミュニティ"],
    [98, "Caving", "Espeleología", "Spéléologie", "Höhlenforschung", "Espeleologia", "Speleologie", "洞穴探险", "洞窟探検"],
    [99, "Cave", "Cueva", "Grotte", "Höhle", "Caverna", "Grot", "洞穴", "洞窟"],
    [100, "Tie", "Corbata", "Cravate", "Krawatte", "Gravata", "Stropdas", "领带", "ネクタイ"],
    [101, "Cabinetry", "Armarios", "Meubles de rangement", "Schränke", "Armários", "Kasten", "橱柜", "キャビネット"],
    [102, "Underwater", "Bajo el agua", "Sous l'eau", "Unterwasser", "Subaquático", "Onderwater", "水下", "水中"],
    [103, "Clown", "Payaso", "Clown", "Clown", "Palhaço", "Clown", "小丑", "ピエロ"],
    [104, "Nightclub", "Discoteca", "Boîte de nuit", "Nachtclub", "Balada", "Nachtclub", "夜店", "ナイトクラブ"],
    [105, "Cycling", "Ciclismo", "Cyclisme", "Radfahren", "Ciclismo", "Fietsen", "骑行", "サイクリング"],
    [106, "Comet", "Cometa", "Comète", "Komet", "Cometa", "Komeet", "彗星", "彗星"],
    [107, "Mortarboard", "Birrete", "Mortier", "Doktorhut", "Capelo", "Baret", "学位帽", "角帽"],
    [108, "Track", "Pista", "Piste", "Laufbahn", "Pista", "Baan", "跑道", "トラック"],
    [109, "Christmas", "Navidad", "Noël", "Weihnachten", "Natal", "Kerstmis", "圣诞节", "クリスマス"],
    [110, "Church", "Iglesia", "Église", "Kirche", "Igreja", "Kerk", "教堂", "教会"],
    [111, "Clock", "Reloj", "Horloge", "Uhr", "Relógio", "Klok", "时钟", "時計"],
    [112, "Dude", "Tío", "Mec", "Typ", "Cara", "Gast", "小伙", "男性"],
    [113, "Cattle", "Ganado", "Bétail", "Rinder", "Gado", "Vee", "牛", "牛"],
    [114, "Jungle", "Selva", "Jungle", "Dschungel", "Selva", "Jungle", "丛林", "ジャングル"],
    [115, "Desk", "Escritorio", "Bureau", "Schreibtisch", "Escrivaninha", "Bureau", "书桌", "机"],
    [116, "Curling", "Curling", "Curling", "Curling", "Curling", "Curling", "冰壶", "カーリング"],
    [117, "Cuisine", "Cocina", "Cuisine", "Küche", "Culinária", "Keuken", "菜肴", "料理"],
    [118, "Cat", "Gato", "Chat", "Katze", "Gato", "Kat", "猫", "猫"],
    [119, "Juice", "Zumo", "Jus", "Saft", "Suco", "Sap", "果汁", "ジュース"],
    [120, "Couscous", "Cuscús", "Couscous", "Couscous", "Cuscuz", "Couscous", "蒸粗麦粉", "クスクス"],
    [121, "Screenshot", "Captura de pantalla", "Capture d'écran", "Bildschirmfoto", "Captura de tela", "Schermafbeelding", "截图", "スクリーンショット"],
    [122, "Crew", "Tripulación", "Équipage", "Crew", "Tripulação", "Bemanning", "全体成员", "クルー"],
    [123, "Skyline", "Horizonte urbano", "Ligne d'horizon", "Skyline", "Horizonte", "Skyline", "天际线", "スカイライン"],
    [125, "Stuffed toy", "Peluche", "Peluche", "Kuscheltier", "Bicho de pelúcia", "Knuffel", "毛绒玩具", "ぬいぐるみ"],
    [126, "Cookie", "Galleta", "Biscuit", "Keks", "Biscoito", "Koekje", "饼干", "クッキー"],
    [127, "Tile", "Azulejo", "Carrelage", "Fliese", "Azulejo", "Tegel", "瓷砖", "タイル"],
    [128, "Hanukkah", "Janucá", "Hanoucca", "Chanukka", "Hanukkah", "Chanoeka", "光明节", "ハヌカー"],
    [129, "Crochet", "Ganchillo", "Crochet", "Häkeln", "Crochê", "Haakwerk", "钩针编织", "かぎ針編み"],
    [130, "Skateboarder", "Patinador", "Skateur", "Skateboarder", "Skatista", "Skateboarder", "滑板手", "スケートボーダー"],
    [131, "Clipper ship", "Clíper", "Clipper", "Klipper", "Clíper", "Klipper", "飞剪船", "クリッパー"],
    [132, "Nail", "Uña", "Ongle", "Nagel", "Unha", "Nagel", "指甲", "爪"],
    [133, "Cola", "Refresco de cola", "Cola", "Cola", "Refrigerante de cola", "Cola", "可乐", "コーラ"],
    [134, "Cutlery", "Cubiertos", "Couverts", "Besteck", "Talheres", "Bestek", "餐具", "カトラリー"],
    [135, "Menu", "Menú", "Menu", "Speisekarte", "Cardápio", "Menukaart", "菜单", "メニュー"],
    [137, "Sari", "Sari", "Sari", "Sari", "Sári", "Sari", "纱丽", "サリー"],
    [138, "Plush", "Felpa", "Peluche", "Plüsch", "Pelúcia", "Pluche", "毛绒", "ぬいぐるみ"],
    [139, "Pocket", "Bolsillo", "Poche", "Tasche", "Bolso", "Zak", "口袋", "ポケット"],
    [140, "Neon", "Neón", "Néon", "Neon", "Neon", "Neon", "霓虹灯", "ネオン"],
    [141, "Icicle", "Carámbano", "Stalactite de glace", "Eiszapfen", "Pingente de gelo", "IJspegel", "冰柱", "つらら"],
    [142, "Pasteles", "Pasteles", "Pasteles", "Pasteles", "Pasteles", "Pasteles", "Pasteles", "パステレス"],
    [143, "Chain", "Cadena", "Chaîne", "Kette", "Corrente", "Ketting", "链条", "チェーン"],
    [144, "Dance", "Baile", "Danse", "Tanz", "Dança", "Dans", "舞蹈", "ダンス"],
    [145, "Dune", "Duna", "Dune", "Düne", "Duna", "Duin", "沙丘", "砂丘"],
    [146, "Santa Claus", "Papá Noel", "Père Noël", "Weihnachtsmann", "Papai Noel", "Kerstman", "圣诞老人", "サンタクロース"],
    [147, "Thanksgiving", "Acción de Gracias", "Thanksgiving", "Erntedankfest", "Ação de Graças", "Thanksgiving", "感恩节", "感謝祭"],
    [148, "Tuxedo", "Esmoquin", "Smoking", "Smoking", "Smoking", "Smoking", "燕尾服", "タキシード"],
    [149, "Mouth", "Boca", "Bouche", "Mund", "Boca", "Mond", "嘴", "口"],
    [150, "Desert", "Desierto", "Désert", "Wüste", "Deserto", "Woestijn", "沙漠", "砂漠"],
    [151, "Dinosaur", "Dinosaurio", "Dinosaure", "Dinosaurier", "Dinossauro", "Dinosaurus", "恐龙", "恐竜"],
    [152, "Mufti", "Ropa de calle", "Tenue civile", "Zivilkleidung", "Roupa civil", "Burgerkleding", "便装", "私服"],
    [153, "Fire", "Fuego", "Feu", "Feuer", "Fogo", "Vuur", "火", "火"],
    [154, "Bedroom", "Dormitorio", "Chambre", "Schlafzimmer", "Quarto", "Slaapkamer", "卧室", "寝室"],
    [155, "Goggles", "Gafas protectoras", "Lunettes de protection", "Schutzbrille", "Óculos de proteção", "Duikbril", "护目镜", "ゴーグル"],
    [156, "Dragon", "Dragón", "Dragon", "Drache", "Dragão", "Draak", "龙", "ドラゴン"],
    [157, "Couch", "Sofá", "Canapé", "Sofa", "Sofá", "Bank", "沙发", "ソファ"],
    [158, "Sledding", "Trineo", "Luge", "Schlittenfahren", "Trenó", "Sleeën", "滑雪橇", "そり遊び"],
    [159, "Cap", "Gorra", "Casquette", "Kappe", "Boné", "Pet", "鸭舌帽", "キャップ"],
    [160, "Whiteboard", "Pizarra blanca", "Tableau blanc", "Whiteboard", "Quadro branco", "Whiteboard", "白板", "ホワイトボード"],
    [161, "Hat", "Sombrero", "Chapeau", "Hut", "Chapéu", "Hoed", "帽子", "帽子"],
    [162, "Gelato", "Helado", "Glace", "Eis", "Sorvete", "IJs", "意式冰淇淋", "ジェラート"],
    [163, "Cavalier King Charles", "Cavalier King Charles", "Cavalier King Charles", "Cavalier King Charles", "Cavalier King Charles", "Cavalier King Charles", "查理王小猎犬", "キャバリア"],
    [164, "Beanie", "Gorro", "Bonnet", "Mütze", "Gorro", "Muts", "毛线帽", "ニット帽"],
    [165, "Jersey", "Camiseta deportiva", "Maillot", "Trikot", "Camisa esportiva", "Shirt", "球衣", "ジャージ"],
    [166, "Scarf", "Bufanda", "Écharpe", "Schal", "Cachecol", "Sjaal", "围巾", "マフラー"],
    [167, "Vacation", "Vacaciones", "Vacances", "Urlaub", "Férias", "Vakantie", "度假", "休暇"],
    [168, "Pitch", "Campo de juego", "Terrain", "Spielfeld", "Campo", "Speelveld", "球场", "競技場"],
    [169, "Blackboard", "Pizarra", "Tableau noir", "Tafel", "Quadro-negro", "Schoolbord", "黑板", "黒板"],
    [170, "DJ", "DJ", "DJ", "DJ", "DJ", "DJ", "DJ", "DJ"],
    [171, "Monument", "Monumento", "Monument", "Denkmal", "Monumento", "Monument", "纪念碑", "記念碑"],
    [172, "Bumper", "Parachoques", "Pare-chocs", "Stoßstange", "Para-choque", "Bumper", "保险杠", "バンパー"],
    [173, "Longboard", "Longboard", "Longboard", "Longboard", "Longboard", "Longboard", "长板", "ロングボード"],
    [174, "Waterfowl", "Aves acuáticas", "Oiseaux aquatiques", "Wasservögel", "Aves aquáticas", "Watervogels", "水禽", "水鳥"],
    [175, "Flesh", "Piel", "Chair", "Haut", "Pele", "Huid", "肌肤", "肌"],
    [176, "Net", "Red", "Filet", "Netz", "Rede", "Net", "网", "ネット"],
    [177, "Icing", "Glaseado", "Glaçage", "Zuckerguss", "Cobertura", "Glazuur", "糖霜", "アイシング"],
    [178, "Dalmatian", "Dálmata", "Dalmatien", "Dalmatiner", "Dálmata", "Dalmatiër", "斑点狗", "ダルメシアン"],
    [179, "Speedboat", "Lancha", "Hors-bord", "Schnellboot", "Lancha", "Speedboot", "快艇", "モーターボート"],
    [180, "Trunk", "Tronco", "Tronc", "Baumstamm", "Tronco", "Stam", "树干", "幹"],
    [181, "Coffee", "Café", "Café", "Kaffee", "Café", "Koffie", "咖啡", "コーヒー"],
    [182, "Soccer", "Fútbol", "Football", "Fußball", "Futebol", "Voetbal", "足球", "サッカー"],
    [183, "Ragdoll cat", "Gato ragdoll", "Chat ragdoll", "Ragdoll-Katze", "Gato ragdoll", "Ragdoll-kat", "布偶猫", "ラグドール"],
    [184, "Food", "Comida", "Nourriture", "Essen", "Comida", "Eten", "食物", "食べ物"],
    [185, "Standing", "De pie", "Debout", "Stehen", "Em pé", "Staan", "站立", "立っている"],
    [186, "Fiction", "Ficción", "Fiction", "Fiktion", "Ficção", "Fictie", "虚构", "フィクション"],
    [187, "Fruit", "Fruta", "Fruit", "Obst", "Fruta", "Fruit", "水果", "果物"],
    [188, "Pho", "Pho", "Phở", "Pho", "Pho", "Pho", "越南河粉", "フォー"],
    [189, "Sparkler", "Bengala", "Cierge magique", "Wunderkerze", "Estrelinha", "Sterretje", "烟花棒", "線香花火"],
    [190, "Presentation", "Presentación", "Présentation", "Präsentation", "Apresentação", "Presentatie", "演示", "プレゼンテーション"],
    [191, "Swing", "Columpio", "Balançoire", "Schaukel", "Balanço", "Schommel", "秋千", "ブランコ"],
    [192, "Cairn terrier", "Cairn terrier", "Cairn terrier", "Cairn Terrier", "Cairn terrier", "Cairnterriër", "凯恩㹴", "ケアーン・テリア"],
    [193, "Forest", "Bosque", "Forêt", "Wald", "Floresta", "Bos", "森林", "森"],
    [194, "Flag", "Bandera", "Drapeau", "Flagge", "Bandeira", "Vlag", "旗帜", "旗"],
    [195, "Frigate", "Fragata", "Frégate", "Fregatte", "Fragata", "Fregat", "护卫舰", "フリゲート"],
    [196, "Foot", "Pie", "Pied", "Fuß", "Pé", "Voet", "脚", "足"],
    [197, "Jacket", "Chaqueta", "Veste", "Jacke", "Jaqueta", "Jas", "夹克", "ジャケット"],
    [199, "Pillow", "Almohada", "Oreiller", "Kopfkissen", "Travesseiro", "Hoofdkussen", "枕头", "枕"],
    [201, "Bathing", "Baño", "Bain", "Baden", "Banho", "Baden", "沐浴", "入浴"],
    [202, "Glacier", "Glaciar", "Glacier", "Gletscher", "Geleira", "Gletsjer", "冰川", "氷河"],
    [203, "Gymnastics", "Gimnasia", "Gymnastique", "Turnen", "Ginástica", "Gymnastiek", "体操", "体操"],
    [204, "Ear", "Oreja", "Oreille", "Ohr", "Orelha", "Oor", "耳朵", "耳"],
    [205, "Flora", "Flora", "Flore", "Flora", "Flora", "Flora", "植物群", "植物"],
    [206, "Shell", "Concha", "Coquillage", "Muschel", "Concha", "Schelp", "贝壳", "貝殻"],
    [207, "Grandparent", "Abuelos", "Grands-parents", "Großeltern", "Avós", "Grootouder", "祖父母", "祖父母"],
    [208, "Ruins", "Ruinas", "Ruines", "Ruinen", "Ruínas", "Ruïnes", "废墟", "遺跡"],
    [209, "Eyelash", "Pestaña", "Cil", "Wimper", "Cílio", "Wimper", "睫毛", "まつげ"],
    [210, "Bunk bed", "Litera", "Lits superposés", "Etagenbett", "Beliche", "Stapelbed", "双层床", "二段ベッド"],
    [211, "Balance", "Equilibrio", "Équilibre", "Gleichgewicht", "Equilíbrio", "Evenwicht", "平衡", "バランス"],
    [212, "Backpacking", "Mochilero", "Randonnée", "Rucksackreise", "Mochilão", "Backpacken", "背包旅行", "バックパッキング"],
    [213, "Horse", "Caballo", "Cheval", "Pferd", "Cavalo", "Paard", "马", "馬"],
    [214, "Glitter", "Purpurina", "Paillettes", "Glitzer", "Glitter", "Glitter", "亮片", "ラメ"],
    [215, "Saucer", "Platillo", "Soucoupe", "Untertasse", "Pires", "Schotel", "茶碟", "ソーサー"],
    [216, "Hair", "Pelo", "Cheveux", "Haare", "Cabelo", "Haar", "头发", "髪"],
    [217, "Miniature", "Miniatura", "Miniature", "Miniatur", "Miniatura", "Miniatuur", "微缩模型", "ミニチュア"],
    [218, "Crowd", "Multitud", "Foule", "Menschenmenge", "Multidão", "Menigte", "人群", "群衆"],
    [219, "Curtain", "Cortina", "Rideau", "Vorhang", "Cortina", "Gordijn", "窗帘", "カーテン"],
    [220, "Icon", "Icono", "Icône", "Symbol", "Ícone", "Pictogram", "图标", "アイコン"],
    [221, "Pixie-bob cat", "Gato pixie-bob", "Chat pixie-bob", "Pixie-Bob-Katze", "Gato pixie-bob", "Pixie-bob-kat", "北美短毛猫", "ピクシーボブ"],
    [222, "Herd", "Manada", "Troupeau", "Herde", "Rebanho", "Kudde", "兽群", "群れ"],
    [223, "Insect", "Insecto", "Insecte", "Insekt", "Inseto", "Insect", "昆虫", "昆虫"],
    [224, "Ice", "Hielo", "Glace", "Eis", "Gelo", "IJs", "冰", "氷"],
    [225, "Bangle", "Brazalete", "Jonc", "Armreif", "Bracelete", "Armband", "手镯", "バングル"],
    [226, "Flap", "Solapa", "Rabat", "Klappe", "Aba", "Flap", "翻盖", "フラップ"],
    [227, "Jewelry", "Joyería", "Bijoux", "Schmuck", "Joias", "Sieraden", "珠宝", "ジュエリー"],
    [228, "Knitting", "Punto", "Tricot", "Stricken", "Tricô", "Breien", "编织", "編み物"],
    [229, "Centerpiece", "Centro de mesa", "Centre de table", "Tischdekoration", "Centro de mesa", "Tafelstuk", "餐桌摆饰", "センターピース"],
    [230, "Outerwear", "Ropa de abrigo", "Vêtements d'extérieur", "Oberbekleidung", "Agasalho", "Bovenkleding", "外套", "アウター"],
    [231, "Love", "Amor", "Amour", "Liebe", "Amor", "Liefde", "爱", "愛"],
    [232, "Muscle", "Músculo", "Muscle", "Muskel", "Músculo", "Spier", "肌肉", "筋肉"],
    [233, "Motorcycle", "Motocicleta", "Moto", "Motorrad", "Moto", "Motor", "摩托车", "オートバイ"],
    [234, "Money", "Dinero", "Argent", "Geld", "Dinheiro", "Geld", "钱", "お金"],
    [235, "Mosque", "Mezquita", "Mosquée", "Moschee", "Mesquita", "Moskee", "清真寺", "モスク"],
    [236, "Tableware", "Vajilla", "Vaisselle", "Geschirr", "Louça", "Servies", "餐具", "食器"],
    [237, "Ballroom", "Salón de baile", "Salle de bal", "Ballsaal", "Salão de baile", "Balzaal", "舞厅", "ボールルーム"],
    [238, "Kayak", "Kayak", "Kayak", "Kajak", "Caiaque", "Kajak", "皮划艇", "カヤック"],
    [239, "Leisure", "Ocio", "Loisirs", "Freizeit", "Lazer", "Vrije tijd", "休闲", "レジャー"],
    [240, "Receipt", "Recibo", "Reçu", "Quittung", "Recibo", "Bonnetje", "收据", "レシート"],
    [241, "Lake", "Lago", "Lac", "See", "Lago", "Meer", "湖", "湖"],
    [242, "Lighthouse", "Faro", "Phare", "Leuchtturm", "Farol", "Vuurtoren", "灯塔", "灯台"],
    [243, "Bridle", "Brida", "Bride", "Zaumzeug", "Rédea", "Hoofdstel", "马笼头", "馬勒"],
    [244, "Leather", "Cuero", "Cuir", "Leder", "Couro", "Leer", "皮革", "革"],
    [245, "Horn", "Cuerno", "Corne", "Horn", "Chifre", "Hoorn", "角", "角"],
    [246, "Strap", "Correa", "Sangle", "Riemen", "Alça", "Riem", "带子", "ストラップ"],
    [247, "Lego", "Lego", "Lego", "Lego", "Lego", "Lego", "乐高", "レゴ"],
    [248, "Scuba diving", "Buceo", "Plongée", "Tauchen", "Mergulho", "Duiken", "水肺潜水", "スキューバダイビング"],
    [249, "Leggings", "Mallas", "Legging", "Leggings", "Legging", "Legging", "打底裤", "レギンス"],
    [250, "Pool", "Piscina", "Piscine", "Pool", "Piscina", "Zwembad", "泳池", "プール"],
    [251, "Musical instrument", "Instrumento musical", "Instrument de musique", "Musikinstrument", "Instrumento musical", "Muziekinstrument", "乐器", "楽器"],
    [252, "Musical", "Musical", "Comédie musicale", "Musical", "Musical", "Musical", "音乐剧", "ミュージカル"],
    [253, "Metal", "Metal", "Métal", "Metall", "Metal", "Metaal", "金属", "金属"],
    [254, "Moon", "Luna", "Lune", "Mond", "Lua", "Maan", "月亮", "月"],
    [255, "Blazer", "Americana", "Blazer", "Blazer", "Blazer", "Colbert", "西装外套", "ブレザー"],
    [256, "Wedding", "Boda", "Mariage", "Hochzeit", "Casamento", "Bruiloft", "婚礼", "結婚式"],
    [257, "Mobile phone", "Teléfono móvil", "Téléphone portable", "Handy", "Celular", "Mobiele telefoon", "手机", "携帯電話"],
    [258, "Militia", "Milicia", "Milice", "Miliz", "Milícia", "Militie", "民兵", "民兵"],
    [259, "Tablecloth", "Mantel", "Nappe", "Tischdecke", "Toalha de mesa", "Tafelkleed", "桌布", "テーブルクロス"],
    [260, "Party", "Fiesta", "Fête", "Party", "Festa", "Feest", "派对", "パーティー"],
    [261, "Nebula", "Nebulosa", "Nébuleuse", "Nebel", "Nebulosa", "Nevel", "星云", "星雲"],
    [262, "News", "Noticias", "Actualités", "Nachrichten", "Notícias", "Nieuws", "新闻", "ニュース"],
    [263, "Newspaper", "Periódico", "Journal", "Zeitung", "Jornal", "Krant", "报纸", "新聞"],
    [265, "Piano", "Piano", "Piano", "Klavier", "Piano", "Piano", "钢琴", "ピアノ"],
    [266, "Plant", "Planta", "Plante", "Pflanze", "Planta", "Plant", "植物", "植物"],
    [267, "Passport", "Pasaporte", "Passeport", "Reisepass", "Passaporte", "Paspoort", "护照", "パスポート"],
    [268, "Penguin", "Pingüino", "Manchot", "Pinguin", "Pinguim", "Pinguïn", "企鹅", "ペンギン"],
    [269, "Shikoku dog", "Shikoku", "Shikoku", "Shikoku", "Shikoku", "Shikoku", "四国犬", "四国犬"],
    [270, "Palace", "Palacio", "Palais", "Palast", "Palácio", "Paleis", "宫殿", "宮殿"],
    [271, "Doily", "Tapete de encaje", "Napperon", "Deckchen", "Toalhinha", "Kleedje", "蕾丝垫", "ドイリー"],
    [272, "Polo", "Polo", "Polo", "Polo", "Polo", "Polo", "马球", "ポロ"],
    [273, "Paper", "Papel", "Papier", "Papier", "Papel", "Papier", "纸张", "紙"],
    [274, "Pop music", "Música pop", "Musique pop", "Popmusik", "Música pop", "Popmuziek", "流行音乐", "ポップ音楽"],
    [275, "Skiff", "Esquife", "Esquif", "Skiff", "Esquife", "Skiff", "小艇", "小舟"],
    [276, "Pizza", "Pizza", "Pizza", "Pizza", "Pizza", "Pizza", "披萨", "ピザ"],
    [277, "Pet", "Mascota", "Animal de compagnie", "Haustier", "Animal de estimação", "Huisdier", "宠物", "ペット"],
    [278, "Quilting", "Acolchado", "Matelassage", "Quilten", "Patchwork", "Quilten", "绗缝", "キルティング"],
    [279, "Cage", "Jaula", "Cage", "Käfig", "Gaiola", "Kooi", "笼子", "ケージ"],
    [280, "Skateboard", "Monopatín", "Skateboard", "Skateboard", "Skate", "Skateboard", "滑板", "スケートボード"],
    [281, "Surfing", "Surf", "Surf", "Surfen", "Surfe", "Surfen", "冲浪", "サーフィン"],
    [282, "Rugby", "Rugby", "Rugby", "Rugby", "Rúgbi", "Rugby", "橄榄球", "ラグビー"],
    [283, "Lipstick", "Pintalabios", "Rouge à lèvres", "Lippenstift", "Batom", "Lippenstift", "口红", "口紅"],
    [284, "River", "Río", "Rivière", "Fluss", "Rio", "Rivier", "河流", "川"],
    [285, "Race", "Carrera", "Course", "Rennen", "Corrida", "Race", "比赛", "レース"],
    [286, "Rowing", "Remo", "Aviron", "Rudern", "Remo", "Roeien", "划船", "ボート競技"],
    [287, "Road", "Carretera", "Route", "Straße", "Estrada", "Weg", "道路", "道路"],
    [288, "Running", "Correr", "Course à pied", "Laufen", "Corrida", "Hardlopen", "跑步", "ランニング"],
    [289, "Room", "Habitación", "Pièce", "Zimmer", "Cômodo", "Kamer", "房间", "部屋"],
    [290, "Roof", "Tejado", "Toit", "Dach", "Telhado", "Dak", "屋顶", "屋根"],
    [291, "Star", "Estrella", "Étoile", "Stern", "Estrela", "Ster", "星星", "星"],
    [292, "Sports", "Deportes", "Sport", "Sport", "Esportes", "Sport", "运动", "スポーツ"],
    [293, "Shoe", "Zapato", "Chaussure", "Schuh", "Sapato", "Schoen", "鞋", "靴"],
    [294, "Tubing", "Flotador", "Bouée tractée", "Tubing", "Boia", "Tuben", "皮筏漂流", "チュービング"],
    [295, "Space", "Espacio", "Espace", "Weltraum", "Espaço", "Ruimte", "太空", "宇宙"],
    [296, "Sleep", "Dormir", "Sommeil", "Schlaf", "Sono", "Slapen", "睡觉", "睡眠"],
    [297, "Skin", "Piel", "Peau", "Haut", "Pele", "Huid", "皮肤", "肌"],
    [298, "Swimming", "Natación", "Natation", "Schwimmen", "Natação", "Zwemmen", "游泳", "水泳"],
    [299, "School", "Escuela", "École", "Schule", "Escola", "School", "学校", "学校"],
    [300, "Sushi", "Sushi", "Sushi", "Sushi", "Sushi", "Sushi", "寿司", "寿司"],
    [301, "Loveseat", "Sofá de dos plazas", "Causeuse", "Zweisitzer", "Sofá de dois lugares", "Tweezitsbank", "双人沙发", "2人掛けソファ"],
    [302, "Superman", "Superman", "Superman", "Superman", "Superman", "Superman", "超人", "スーパーマン"],
    [303, "Cool", "Genial", "Cool", "Cool", "Legal", "Cool", "酷", "クール"],
    [304, "Skiing", "Esquí", "Ski", "Skifahren", "Esqui", "Skiën", "滑雪", "スキー"],
    [305, "Submarine", "Submarino", "Sous-marin", "U-Boot", "Submarino", "Onderzeeër", "潜水艇", "潜水艦"],
    [306, "Song", "Canción", "Chanson", "Lied", "Música", "Lied", "歌曲", "歌"],
    [307, "Class", "Clase", "Cours", "Unterricht", "Aula", "Les", "课堂", "授業"],
    [308, "Skyscraper", "Rascacielos", "Gratte-ciel", "Wolkenkratzer", "Arranha-céu", "Wolkenkrabber", "摩天大楼", "超高層ビル"],
    [309, "Volcano", "Volcán", "Volcan", "Vulkan", "Vulcão", "Vulkaan", "火山", "火山"],
    [310, "Television", "Televisión", "Télévision", "Fernseher", "Televisão", "Televisie", "电视", "テレビ"],
    [311, "Rein", "Rienda", "Rêne", "Zügel", "Rédea", "Teugel", "缰绳", "手綱"],
    [312, "Tattoo", "Tatuaje", "Tatouage", "Tattoo", "Tatuagem", "Tatoeage", "纹身", "タトゥー"],
    [313, "Train", "Tren", "Train", "Zug", "Trem", "Trein", "火车", "電車"],
    [314, "Handrail", "Pasamanos", "Rampe", "Handlauf", "Corrimão", "Leuning", "扶手", "手すり"],
    [315, "Cup", "Taza", "Tasse", "Tasse", "Xícara", "Kopje", "杯子", "カップ"],
    [316, "Vehicle", "Vehículo", "Véhicule", "Fahrzeug", "Veículo", "Voertuig", "车辆", "乗り物"],
    [317, "Handbag", "Bolso", "Sac à main", "Handtasche", "Bolsa", "Handtas", "手提包", "ハンドバッグ"],
    [318, "Lampshade", "Pantalla de lámpara", "Abat-jour", "Lampenschirm", "Cúpula", "Lampenkap", "灯罩", "ランプシェード"],
    [319, "Event", "Evento", "Événement", "Veranstaltung", "Evento", "Evenement", "活动", "イベント"],
    [320, "Wine", "Vino", "Vin", "Wein", "Vinho", "Wijn", "葡萄酒", "ワイン"],
    [321, "Wing", "Ala", "Aile", "Flügel", "Asa", "Vleugel", "翅膀", "翼"],
    [322, "Wheel", "Rueda", "Roue", "Rad", "Roda", "Wiel", "车轮", "車輪"],
    [323, "Wakeboarding", "Wakeboard", "Wakeboard", "Wakeboarden", "Wakeboard", "Wakeboarden", "尾波滑水", "ウェイクボード"],
    [324, "Web page", "Página web", "Page web", "Webseite", "Página da web", "Webpagina", "网页", "ウェブページ"],
    [327, "Ranch", "Rancho", "Ranch", "Ranch", "Rancho", "Ranch", "牧场", "牧場"],
    [328, "Fishing", "Pesca", "Pêche", "Angeln", "Pesca", "Vissen", "钓鱼", "釣り"],
    [329, "Heart", "Corazón", "Cœur", "Herz", "Coração", "Hart", "爱心", "ハート"],
    [330, "Cotton", "Algodón", "Coton", "Baumwolle", "Algodão", "Katoen", "棉花", "綿"],
    [331, "Cappuccino", "Capuchino", "Cappuccino", "Cappuccino", "Cappuccino", "Cappuccino", "卡布奇诺", "カプチーノ"],
    [332, "Bread", "Pan", "Pain", "Brot", "Pão", "Brood", "面包", "パン"],
    [333, "Sand", "Arena", "Sable", "Sand", "Areia", "Zand", "沙子", "砂"],
    [335, "Museum", "Museo", "Musée", "Museum", "Museu", "Museum", "博物馆", "博物館"],
    [336, "Helicopter", "Helicóptero", "Hélicoptère", "Hubschrauber", "Helicóptero", "Helikopter", "直升机", "ヘリコプター"],
    [337, "Mountain", "Montaña", "Montagne", "Berg", "Montanha", "Berg", "山", "山"],
    [338, "Duck", "Pato", "Canard", "Ente", "Pato", "Eend", "鸭子", "アヒル"],
    [339, "Soil", "Tierra", "Terre", "Erde", "Solo", "Aarde", "土壤", "土"],
    [340, "Turtle", "Tortuga", "Tortue", "Schildkröte", "Tartaruga", "Schildpad", "乌龟", "カメ"],
    [341, "Crocodile", "Cocodrilo", "Crocodile", "Krokodil", "Crocodilo", "Krokodil", "鳄鱼", "ワニ"],
    [342, "Musician", "Músico", "Musicien", "Musiker", "Músico", "Muzikant", "音乐家", "ミュージシャン"],
    [343, "Sneakers", "Zapatillas", "Baskets", "Turnschuhe", "Tênis", "Sneakers", "运动鞋", "スニーカー"],
    [344, "Wool", "Lana", "Laine", "Wolle", "Lã", "Wol", "羊毛", "ウール"],
    [345, "Ring", "Anillo", "Bague", "Ring", "Anel", "Ring", "戒指", "指輪"],
    [346, "Singer", "Cantante", "Chanteur", "Sänger", "Cantor", "Zanger", "歌手", "歌手"],
    [347, "Carnival", "Carnaval", "Carnaval", "Karneval", "Carnaval", "Carnaval", "狂欢节", "カーニバル"],
    [348, "Snowboarding", "Snowboard", "Snowboard", "Snowboarden", "Snowboard", "Snowboarden", "单板滑雪", "スノーボード"],
    [349, "Waterskiing", "Esquí acuático", "Ski nautique", "Wasserski", "Esqui aquático", "Waterskiën", "滑水", "水上スキー"],
    [350, "Wall", "Pared", "Mur", "Wand", "Parede", "Muur", "墙", "壁"],
    [351, "Rocket", "Cohete", "Fusée", "Rakete", "Foguete", "Raket", "火箭", "ロケット"],
    [352, "Countertop", "Encimera", "Plan de travail", "Arbeitsplatte", "Bancada", "Aanrecht", "台面", "カウンター"],
    [353, "Beach", "Playa", "Plage", "Strand", "Praia", "Strand", "海滩", "ビーチ"],
    [354, "Rainbow", "Arcoíris", "Arc-en-ciel", "Regenbogen", "Arco-íris", "Regenboog", "彩虹", "虹"],
    [355, "Branch", "Rama", "Branche", "Ast", "Galho", "Tak", "树枝", "枝"],
    [356, "Moustache", "Bigote", "Moustache", "Schnurrbart", "Bigode", "Snor", "小胡子", "口ひげ"],
    [357, "Garden", "Jardín", "Jardin", "Garten", "Jardim", "Tuin", "花园", "庭"],
    [358, "Gown", "Vestido de gala", "Robe de soirée", "Abendkleid", "Vestido de gala", "Galajurk", "礼服", "ガウン"],
    [359, "Field", "Campo", "Champ", "Feld", "Campo", "Veld", "田野", "野原"],
    [360, "Dog", "Perro", "Chien", "Hund", "Cachorro", "Hond", "狗", "犬"],
    [361, "Superhero", "Superhéroe", "Super-héros", "Superheld", "Super-herói", "Superheld", "超级英雄", "スーパーヒーロー"],
    [362, "Flower", "Flor", "Fleur", "Blume", "Flor", "Bloem", "花", "花"],
    [363, "Placemat", "Mantel individual", "Set de table", "Platzset", "Jogo americano", "Placemat", "餐垫", "ランチョンマット"],
    [364, "Subwoofer", "Subwoofer", "Caisson de basses", "Subwoofer", "Subwoofer", "Subwoofer", "低音炮", "サブウーファー"],
    [365, "Cathedral", "Catedral", "Cathédrale", "Kathedrale", "Catedral", "Kathedraal", "大教堂", "大聖堂"],
    [366, "Building", "Edificio", "Bâtiment", "Gebäude", "Edifício", "Gebouw", "建筑", "建物"],
    [367, "Airplane", "Avión", "Avion", "Flugzeug", "Avião", "Vliegtuig", "飞机", "飛行機"],
    [368, "Fur", "Pelaje", "Fourrure", "Fell", "Pelo", "Vacht", "毛皮", "毛皮"],
    [369, "Bull", "Toro", "Taureau", "Stier", "Touro", "Stier", "公牛", "雄牛"],
    [370, "Bench", "Banco", "Banc", "Bank", "Banco", "Bankje", "长椅", "ベンチ"],
    [371, "Temple", "Templo", "Temple", "Tempel", "Templo", "Tempel", "寺庙", "寺院"],
    [372, "Butterfly", "Mariposa", "Papillon", "Schmetterling", "Borboleta", "Vlinder", "蝴蝶", "蝶"],
    [373, "Model", "Modelo", "Mannequin", "Model", "Modelo", "Model", "模特", "モデル"],
    [374, "Marathon", "Maratón", "Marathon", "Marathon", "Maratona", "Marathon", "马拉松", "マラソン"],
    [375, "Needlework", "Costura", "Travaux d'aiguille", "Handarbeit", "Costura", "Handwerk", "针线活", "針仕事"],
    [376, "Kitchen", "Cocina", "Cuisine", "Küche", "Cozinha", "Keuken", "厨房", "キッチン"],
    [377, "Castle", "Castillo", "Château", "Burg", "Castelo", "Kasteel", "城堡", "城"],
    [378, "Aurora", "Aurora", "Aurore", "Polarlicht", "Aurora", "Poollicht", "极光", "オーロラ"],
    [379, "Larva", "Larva", "Larve", "Larve", "Larva", "Larve", "幼虫", "幼虫"],
    [380, "Racing", "Carreras", "Course automobile", "Rennsport", "Corrida", "Racen", "赛车", "レース"],
    [382, "Airliner", "Avión de pasajeros", "Avion de ligne", "Verkehrsflugzeug", "Avião comercial", "Lijnvliegtuig", "客机", "旅客機"],
    [383, "Dam", "Presa", "Barrage", "Staudamm", "Barragem", "Dam", "水坝", "ダム"],
    [384, "Textile", "Tela", "Textile", "Textil", "Tecido", "Textiel", "纺织品", "布地"],
    [385, "Groom", "Novio", "Marié", "Bräutigam", "Noivo", "Bruidegom", "新郎", "新郎"],
    [386, "Fun", "Diversión", "Amusement", "Spaß", "Diversão", "Plezier", "乐趣", "楽しい"],
    [387, "Steaming", "Humeante", "Fumant", "Dampfend", "Fumegante", "Dampend", "热气腾腾", "湯気"],
    [388, "Vegetable", "Verdura", "Légume", "Gemüse", "Legume", "Groente", "蔬菜", "野菜"],
    [389, "Unicycle", "Monociclo", "Monocycle", "Einrad", "Monociclo", "Eenwieler", "独轮车", "一輪車"],
    [390, "Jeans", "Vaqueros", "Jean", "Jeans", "Calça jeans", "Spijkerbroek", "牛仔裤", "ジーンズ"],
    [391, "Flowerpot", "Maceta", "Pot de fleurs", "Blumentopf", "Vaso de flores", "Bloempot", "花盆", "植木鉢"],
    [392, "Drawer", "Cajón", "Tiroir", "Schublade", "Gaveta", "Lade", "抽屉", "引き出し"],
    [393, "Cake", "Pastel", "Gâteau", "Kuchen", "Bolo", "Taart", "蛋糕", "ケーキ"],
    [394, "Armrest", "Reposabrazos", "Accoudoir", "Armlehne", "Apoio de braço", "Armleuning", "扶手", "肘掛け"],
    [395, "Aviation", "Aviación", "Aviation", "Luftfahrt", "Aviação", "Luchtvaart", "航空", "航空"],
    [397, "Fog", "Niebla", "Brouillard", "Nebel", "Neblina", "Mist", "雾", "霧"],
    [398, "Fireworks", "Fuegos artificiales", "Feux d'artifice", "Feuerwerk", "Fogos de artifício", "Vuurwerk", "烟花", "花火"],
    [399, "Farm", "Granja", "Ferme", "Bauernhof", "Fazenda", "Boerderij", "农场", "農場"],
    [400, "Seal", "Foca", "Phoque", "Robbe", "Foca", "Zeehond", "海豹", "アザラシ"],
    [401, "Shelf", "Estante", "Étagère", "Regal", "Prateleira", "Plank", "架子", "棚"],
    [402, "Bangs", "Flequillo", "Frange", "Pony", "Franja", "Pony", "刘海", "前髪"],
    [403, "Lightning", "Rayo", "Éclair", "Blitz", "Relâmpago", "Bliksem", "闪电", "稲妻"],
    [404, "Van", "Furgoneta", "Camionnette", "Transporter", "Van", "Busje", "面包车", "バン"],
    [405, "Sphynx cat", "Gato esfinge", "Chat sphynx", "Sphynx-Katze", "Gato sphynx", "Sphynx-kat", "无毛猫", "スフィンクス"],
    [406, "Tire", "Neumático", "Pneu", "Reifen", "Pneu", "Band", "轮胎", "タイヤ"],
    [407, "Denim", "Tela vaquera", "Denim", "Denim", "Jeans", "Denim", "牛仔布", "デニム"],
    [408, "Prairie", "Pradera", "Prairie", "Prärie", "Pradaria", "Prairie", "草原", "大草原"],
    [409, "Snorkeling", "Esnórquel", "Plongée en apnée", "Schnorcheln", "Snorkel", "Snorkelen", "浮潜", "シュノーケリング"],
    [410, "Umbrella", "Paraguas", "Parapluie", "Regenschirm", "Guarda-chuva", "Paraplu", "雨伞", "傘"],
    [411, "Asphalt", "Asfalto", "Asphalte", "Asphalt", "Asfalto", "Asfalt", "沥青", "アスファルト"],
    [412, "Sailboat", "Velero", "Voilier", "Segelboot", "Veleiro", "Zeilboot", "帆船", "ヨット"],
    [413, "Basset hound", "Basset hound", "Basset hound", "Basset Hound", "Basset hound", "Bassethond", "巴吉度猎犬", "バセット・ハウンド"],
    [414, "Pattern", "Estampado", "Motif", "Muster", "Padrão", "Patroon", "图案", "模様"],
    [415, "Supper", "Cena", "Dîner", "Abendessen", "Jantar", "Avondeten", "晚餐", "夕食"],
    [416, "Veil", "Velo", "Voile", "Schleier", "Véu", "Sluier", "面纱", "ベール"],
    [417, "Waterfall", "Cascada", "Cascade", "Wasserfall", "Cachoeira", "Waterval", "瀑布", "滝"],
    [419, "Lunch", "Almuerzo", "Déjeuner", "Mittagessen", "Almoço", "Lunch", "午餐", "昼食"],
    [420, "Odometer", "Cuentakilómetros", "Compteur", "Kilometerzähler", "Hodômetro", "Kilometerteller", "里程表", "走行距離計"],
    [421, "Baby", "Bebé", "Bébé", "Baby", "Bebê", "Baby", "婴儿", "赤ちゃん"],
    [422, "Glasses", "Gafas", "Lunettes", "Brille", "Óculos", "Bril", "眼镜", "メガネ"],
    [423, "Car", "Coche", "Voiture", "Auto", "Carro", "Auto", "汽车", "車"],
    [424, "Aircraft", "Aeronave", "Aéronef", "Luftfahrzeug", "Aeronave", "Luchtvaartuig", "航空器", "航空機"],
    [425, "Hand", "Mano", "Main", "Hand", "Mão", "Hand", "手", "手"],
    [426, "Rodeo", "Rodeo", "Rodéo", "Rodeo", "Rodeio", "Rodeo", "牛仔竞技", "ロデオ"],
    [427, "Canyon", "Cañón", "Canyon", "Schlucht", "Cânion", "Kloof", "峡谷", "峡谷"],
    [428, "Meal", "Comida", "Repas", "Mahlzeit", "Refeição", "Maaltijd", "餐食", "食事"],
    [429, "Softball", "Sóftbol", "Softball", "Softball", "Softbol", "Softbal", "垒球", "ソフトボール"],
    [430, "Alcohol", "Alcohol", "Alcool", "Alkohol", "Álcool", "Alcohol", "酒", "お酒"],
    [431, "Bride", "Novia", "Mariée", "Braut", "Noiva", "Bruid", "新娘", "花嫁"],
    [432, "Swamp", "Pantano", "Marécage", "Sumpf", "Pântano", "Moeras", "沼泽", "沼地"],
    [433, "Pie", "Tarta", "Tarte", "Pie", "Torta", "Taart", "派", "パイ"],
    [434, "Bag", "Bolsa", "Sac", "Tasche", "Bolsa", "Tas", "包", "バッグ"],
    [435, "Joker", "Joker", "Joker", "Joker", "Coringa", "Joker", "小丑", "ジョーカー"],
    [436, "Supervillain", "Supervillano", "Super-méchant", "Superschurke", "Supervilão", "Superschurk", "超级反派", "スーパーヴィラン"],
    [437, "Army", "Ejército", "Armée", "Armee", "Exército", "Leger", "军队", "軍隊"],
    [438, "Canoe", "Canoa", "Canoë", "Kanu", "Canoa", "Kano", "独木舟", "カヌー"],
    [439, "Selfie", "Selfi", "Selfie", "Selfie", "Selfie", "Selfie", "自拍", "自撮り"],
    [440, "Rickshaw", "Rickshaw", "Pousse-pousse", "Rikscha", "Riquixá", "Riksja", "人力车", "人力車"],
    [441, "Barn", "Granero", "Grange", "Scheune", "Celeiro", "Schuur", "谷仓", "納屋"],
    [442, "Archery", "Tiro con arco", "Tir à l'arc", "Bogenschießen", "Tiro com arco", "Boogschieten", "射箭", "アーチェリー"],
    [443, "Aerospace", "Aeroespacial", "Aérospatiale", "Luft- und Raumfahrt", "Aeroespacial", "Ruimtevaart", "航空航天", "航空宇宙"],
    [445, "Storm", "Tormenta", "Tempête", "Sturm", "Tempestade", "Storm", "暴风雨", "嵐"],
    [446, "Helmet", "Casco", "Casque", "Helm", "Capacete", "Helm", "头盔", "ヘルメット"],
  ];

  const AUTO_LABEL_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'nl', 'zh', 'ja'];
  const AUTO_LABELS = new Map(AUTO_LABEL_ROWS.map(row => [row[0], row.slice(1)]));

  // Auto-albums: label groups plus a few non-label signals (faces, screenshots).
  // Shown once at least AUTO_ALBUM_MIN_IMAGES images qualify.
  const AUTO_ALBUM_MIN_SCORE = 0.62;
  const AUTO_ALBUM_DEFS = [
    { key: 'people', icon: 'people', labels: [439] },
    { key: 'screenshots', icon: 'screenshot', labels: [121, 324] },
    { key: 'documents', icon: 'document', labels: [240, 273, 135, 263, 267, 160, 169, 190] },
    { key: 'pets', icon: 'paw', labels: [277, 360, 118, 20, 213, 35, 163, 178, 192, 183, 221, 405, 413, 269, 3, 55, 340, 338, 268, 61, 223, 372, 113, 369, 222, 341, 400, 174, 33] },
    { key: 'food', icon: 'food', labels: [184, 117, 428, 419, 415, 48, 10, 50, 276, 300, 5, 188, 120, 332, 393, 126, 433, 162, 177, 187, 388, 181, 331, 119, 133, 320, 430, 142, 62] },
    { key: 'nature', icon: 'leaf', labels: [54, 49, 353, 337, 193, 241, 284, 417, 150, 145, 202, 4, 427, 39, 309, 359, 408, 362, 266, 205, 357, 354, 378, 445, 403, 397, 254, 432, 114, 99, 79, 102, 22, 28] },
    { key: 'places', icon: 'landmark', labels: [366, 123, 308, 18, 63, 171, 377, 270, 371, 110, 365, 235, 335, 208, 9, 242, 43, 32, 96, 167] },
    { key: 'vehicles', icon: 'car', labels: [423, 316, 233, 42, 52, 313, 45, 412, 179, 404, 11, 336, 424, 367, 382, 351, 238, 438] },
    { key: 'art', icon: 'palette', labels: [2, 93, 186, 361, 436, 435, 302, 37, 156, 220] },
    { key: 'celebrations', icon: 'party', labels: [260, 75, 109, 128, 147, 398, 189, 74, 256, 431, 385, 25, 76, 347, 146, 81, 1] },
    { key: 'sports', icon: 'ball', labels: [292, 182, 282, 40, 429, 304, 281, 105, 288, 374, 298, 203, 280, 130, 348, 116, 38, 285, 380, 442] },
  ];
  const AUTO_ALBUM_MIN_IMAGES = 3;

  const AUTO_ALBUM_ENGLISH = {
    people: 'People', screenshots: 'Screenshots', documents: 'Documents', pets: 'Pets & animals',
    food: 'Food & drink', nature: 'Nature', places: 'Places', vehicles: 'Vehicles',
    art: 'Art & comics', celebrations: 'Celebrations', sports: 'Sports',
  };

  function langIndex() {
    const locale = String(global.MemoI18n?.getLocale?.() || 'en').toLowerCase();
    const index = AUTO_LABEL_LANGS.indexOf(locale.split('-')[0]);
    return index < 0 ? 0 : index;
  }
  function name(index) {
    const names = AUTO_LABELS.get(index);
    return names ? names[langIndex()] || names[0] : '';
  }
  const normalize = value => String(value || '').toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  let searchCache = { lang: -1, names: new Map() };
  function searchNames(index) {
    const lang = langIndex();
    if (searchCache.lang !== lang) searchCache = { lang, names: new Map() };
    let names = searchCache.names.get(index);
    if (!names) {
      const row = AUTO_LABELS.get(index);
      names = row ? [...new Set([row[lang], row[0]].map(normalize))] : [];
      searchCache.names.set(index, names);
    }
    return names;
  }
  function albumName(key) {
    const english = AUTO_ALBUM_ENGLISH[key] || key;
    return global.MemoI18n?.t ? global.MemoI18n.t(english) : english;
  }
  function albumSearchNames(key) {
    return [...new Set([albumName(key), AUTO_ALBUM_ENGLISH[key] || ''].filter(Boolean).map(normalize))];
  }
  function hasLabel(insight, labels, minScore = AUTO_ALBUM_MIN_SCORE) {
    if (!insight?.labels?.length) return false;
    const wanted = new Set(labels);
    return insight.labels.some(([index, score]) => wanted.has(index) && score >= minScore);
  }
  function looksLikeScreenshot(insight, mime) {
    if (hasLabel(insight, [121, 324], 0.6)) return true;
    if (!insight || insight.status !== 'ready' || insight.camera || insight.faces) return false;
    const { width, height } = insight;
    if (String(mime || '').toLowerCase() !== 'image/png' || !width || !height) return false;
    return height / width >= 1.7;   // lossless, no camera EXIF, tall phone aspect
  }
  // The single source of truth for one image's smart albums.
  function albumsForInsight(insight, mime) {
    if (!insight || insight.status !== 'ready') return [];
    const out = [];
    const screenshot = looksLikeScreenshot(insight, mime);
    for (const def of AUTO_ALBUM_DEFS) {
      let member;
      if (def.key === 'people') member = (insight.faces > 0 && insight.faceArea >= 0.004) || hasLabel(insight, def.labels);
      else if (def.key === 'screenshots') member = screenshot;
      else member = hasLabel(insight, def.labels);
      if (member) out.push(def.key);
    }
    return out;
  }
  // Search: an image matches when one of its labels (or the People album) contains the query.
  function insightMatches(insight, query) {
    const q = normalize(query).trim();
    if (!q || !insight || insight.status !== 'ready') return false;
    for (const [index, score] of insight.labels) {
      if (score < 0.6) continue;
      if (searchNames(index).some(candidate => candidate.includes(q))) return true;
    }
    if (insight.faces > 0 && albumSearchNames('people').some(candidate => candidate.includes(q))) return true;
    return false;
  }
  // Confident labels over several images, best first, without the entry's own tags.
  function suggestedTags(insights, existingTags, limit = 4) {
    const existing = new Set((existingTags || []).map(tag => String(tag).toLocaleLowerCase()));
    const best = new Map();
    for (const insight of insights || []) {
      if (!insight || insight.status !== 'ready') continue;
      for (const [index, score] of insight.labels) {
        if (score < 0.7) continue;
        if ((best.get(index) || 0) < score) best.set(index, score);
      }
    }
    const out = [];
    for (const [index, score] of [...best.entries()].sort((a, b) => b[1] - a[1])) {
      const label = name(index);
      if (!label || existing.has(label.toLocaleLowerCase())) continue;
      out.push({ index, name: label, score });
      if (out.length >= limit) break;
    }
    return out;
  }

  global.MemoAutoLabels = {
    name, albumName, albums: AUTO_ALBUM_DEFS, albumsForInsight, insightMatches, suggestedTags,
    minAlbumImages: AUTO_ALBUM_MIN_IMAGES, englishAlbumName: key => AUTO_ALBUM_ENGLISH[key] || key,
    rowCount: AUTO_LABEL_ROWS.length,
  };
})(window);
