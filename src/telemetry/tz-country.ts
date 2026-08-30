/**
 * IANA timezone -> ISO 3166-1 alpha-2 country, so the active-install ping can
 * fill GA4's map without sending an IP address or calling a geo-IP service.
 *
 * Generated from the tzdata `zone.tab` shipped with the OS (public domain).
 * Regenerate with `pnpm run gen:tz-country` after a tzdata bump — zones move
 * between countries rarely, but they do move.
 *
 * Country granularity only, and deliberately so: it is coarse enough not to
 * single anyone out, and it is derived from a local setting rather than from
 * anything about the network connection.
 */

/** `CC|Zone,Zone;CC|Zone` — one string beats a 400-entry object literal in the bundle. */
const PACKED =
  'AD|Europe/Andorra;AE|Asia/Dubai;AF|Asia/Kabul;AG|America/Antigua;AI|America/Anguilla;AL|Euro' +
  'pe/Tirane;AM|Asia/Yerevan;AO|Africa/Luanda;AQ|Antarctica/Casey,Antarctica/Davis,Antarctica/D' +
  'umontDUrville,Antarctica/Mawson,Antarctica/McMurdo,Antarctica/Palmer,Antarctica/Rothera,Anta' +
  'rctica/Syowa,Antarctica/Troll,Antarctica/Vostok;AR|America/Argentina/Buenos_Aires,America/Ar' +
  'gentina/Catamarca,America/Argentina/Cordoba,America/Argentina/Jujuy,America/Argentina/La_Rio' +
  'ja,America/Argentina/Mendoza,America/Argentina/Rio_Gallegos,America/Argentina/Salta,America/' +
  'Argentina/San_Juan,America/Argentina/San_Luis,America/Argentina/Tucuman,America/Argentina/Us' +
  'huaia;AS|Pacific/Pago_Pago;AT|Europe/Vienna;AU|Antarctica/Macquarie,Australia/Adelaide,Austr' +
  'alia/Brisbane,Australia/Broken_Hill,Australia/Darwin,Australia/Eucla,Australia/Hobart,Austra' +
  'lia/Lindeman,Australia/Lord_Howe,Australia/Melbourne,Australia/Perth,Australia/Sydney;AW|Ame' +
  'rica/Aruba;AX|Europe/Mariehamn;AZ|Asia/Baku;BA|Europe/Sarajevo;BB|America/Barbados;BD|Asia/D' +
  'haka;BE|Europe/Brussels;BF|Africa/Ouagadougou;BG|Europe/Sofia;BH|Asia/Bahrain;BI|Africa/Buju' +
  'mbura;BJ|Africa/Porto-Novo;BL|America/St_Barthelemy;BM|Atlantic/Bermuda;BN|Asia/Brunei;BO|Am' +
  'erica/La_Paz;BQ|America/Kralendijk;BR|America/Araguaina,America/Bahia,America/Belem,America/' +
  'Boa_Vista,America/Campo_Grande,America/Cuiaba,America/Eirunepe,America/Fortaleza,America/Mac' +
  'eio,America/Manaus,America/Noronha,America/Porto_Velho,America/Recife,America/Rio_Branco,Ame' +
  'rica/Santarem,America/Sao_Paulo;BS|America/Nassau;BT|Asia/Thimphu;BW|Africa/Gaborone;BY|Euro' +
  'pe/Minsk;BZ|America/Belize;CA|America/Atikokan,America/Blanc-Sablon,America/Cambridge_Bay,Am' +
  'erica/Creston,America/Dawson,America/Dawson_Creek,America/Edmonton,America/Fort_Nelson,Ameri' +
  'ca/Glace_Bay,America/Goose_Bay,America/Halifax,America/Inuvik,America/Iqaluit,America/Moncto' +
  'n,America/Rankin_Inlet,America/Regina,America/Resolute,America/St_Johns,America/Swift_Curren' +
  't,America/Toronto,America/Vancouver,America/Whitehorse,America/Winnipeg;CC|Indian/Cocos;CD|A' +
  'frica/Kinshasa,Africa/Lubumbashi;CF|Africa/Bangui;CG|Africa/Brazzaville;CH|Europe/Zurich;CI|' +
  'Africa/Abidjan;CK|Pacific/Rarotonga;CL|America/Coyhaique,America/Punta_Arenas,America/Santia' +
  'go,Pacific/Easter;CM|Africa/Douala;CN|Asia/Shanghai,Asia/Urumqi;CO|America/Bogota;CR|America' +
  '/Costa_Rica;CU|America/Havana;CV|Atlantic/Cape_Verde;CW|America/Curacao;CX|Indian/Christmas;' +
  'CY|Asia/Famagusta,Asia/Nicosia;CZ|Europe/Prague;DE|Europe/Berlin,Europe/Busingen;DJ|Africa/D' +
  'jibouti;DK|Europe/Copenhagen;DM|America/Dominica;DO|America/Santo_Domingo;DZ|Africa/Algiers;' +
  'EC|America/Guayaquil,Pacific/Galapagos;EE|Europe/Tallinn;EG|Africa/Cairo;EH|Africa/El_Aaiun;' +
  'ER|Africa/Asmara;ES|Africa/Ceuta,Atlantic/Canary,Europe/Madrid;ET|Africa/Addis_Ababa;FI|Euro' +
  'pe/Helsinki;FJ|Pacific/Fiji;FK|Atlantic/Stanley;FM|Pacific/Chuuk,Pacific/Kosrae,Pacific/Pohn' +
  'pei;FO|Atlantic/Faroe;FR|Europe/Paris;GA|Africa/Libreville;GB|Europe/London;GD|America/Grena' +
  'da;GE|Asia/Tbilisi;GF|America/Cayenne;GG|Europe/Guernsey;GH|Africa/Accra;GI|Europe/Gibraltar' +
  ';GL|America/Danmarkshavn,America/Nuuk,America/Scoresbysund,America/Thule;GM|Africa/Banjul;GN' +
  '|Africa/Conakry;GP|America/Guadeloupe;GQ|Africa/Malabo;GR|Europe/Athens;GS|Atlantic/South_Ge' +
  'orgia;GT|America/Guatemala;GU|Pacific/Guam;GW|Africa/Bissau;GY|America/Guyana;HK|Asia/Hong_K' +
  'ong;HN|America/Tegucigalpa;HR|Europe/Zagreb;HT|America/Port-au-Prince;HU|Europe/Budapest;ID|' +
  'Asia/Jakarta,Asia/Jayapura,Asia/Makassar,Asia/Pontianak;IE|Europe/Dublin;IL|Asia/Jerusalem;I' +
  'M|Europe/Isle_of_Man;IN|Asia/Kolkata;IO|Indian/Chagos;IQ|Asia/Baghdad;IR|Asia/Tehran;IS|Atla' +
  'ntic/Reykjavik;IT|Europe/Rome;JE|Europe/Jersey;JM|America/Jamaica;JO|Asia/Amman;JP|Asia/Toky' +
  'o;KE|Africa/Nairobi;KG|Asia/Bishkek;KH|Asia/Phnom_Penh;KI|Pacific/Kanton,Pacific/Kiritimati,' +
  'Pacific/Tarawa;KM|Indian/Comoro;KN|America/St_Kitts;KP|Asia/Pyongyang;KR|Asia/Seoul;KW|Asia/' +
  'Kuwait;KY|America/Cayman;KZ|Asia/Almaty,Asia/Aqtau,Asia/Aqtobe,Asia/Atyrau,Asia/Oral,Asia/Qo' +
  'stanay,Asia/Qyzylorda;LA|Asia/Vientiane;LB|Asia/Beirut;LC|America/St_Lucia;LI|Europe/Vaduz;L' +
  'K|Asia/Colombo;LR|Africa/Monrovia;LS|Africa/Maseru;LT|Europe/Vilnius;LU|Europe/Luxembourg;LV' +
  '|Europe/Riga;LY|Africa/Tripoli;MA|Africa/Casablanca;MC|Europe/Monaco;MD|Europe/Chisinau;ME|E' +
  'urope/Podgorica;MF|America/Marigot;MG|Indian/Antananarivo;MH|Pacific/Kwajalein,Pacific/Majur' +
  'o;MK|Europe/Skopje;ML|Africa/Bamako;MM|Asia/Yangon;MN|Asia/Hovd,Asia/Ulaanbaatar;MO|Asia/Mac' +
  'au;MP|Pacific/Saipan;MQ|America/Martinique;MR|Africa/Nouakchott;MS|America/Montserrat;MT|Eur' +
  'ope/Malta;MU|Indian/Mauritius;MV|Indian/Maldives;MW|Africa/Blantyre;MX|America/Bahia_Bandera' +
  's,America/Cancun,America/Chihuahua,America/Ciudad_Juarez,America/Hermosillo,America/Matamoro' +
  's,America/Mazatlan,America/Merida,America/Mexico_City,America/Monterrey,America/Ojinaga,Amer' +
  'ica/Tijuana;MY|Asia/Kuala_Lumpur,Asia/Kuching;MZ|Africa/Maputo;NA|Africa/Windhoek;NC|Pacific' +
  '/Noumea;NE|Africa/Niamey;NF|Pacific/Norfolk;NG|Africa/Lagos;NI|America/Managua;NL|Europe/Ams' +
  'terdam;NO|Europe/Oslo;NP|Asia/Kathmandu;NR|Pacific/Nauru;NU|Pacific/Niue;NZ|Pacific/Auckland' +
  ',Pacific/Chatham;OM|Asia/Muscat;PA|America/Panama;PE|America/Lima;PF|Pacific/Gambier,Pacific' +
  '/Marquesas,Pacific/Tahiti;PG|Pacific/Bougainville,Pacific/Port_Moresby;PH|Asia/Manila;PK|Asi' +
  'a/Karachi;PL|Europe/Warsaw;PM|America/Miquelon;PN|Pacific/Pitcairn;PR|America/Puerto_Rico;PS' +
  '|Asia/Gaza,Asia/Hebron;PT|Atlantic/Azores,Atlantic/Madeira,Europe/Lisbon;PW|Pacific/Palau;PY' +
  '|America/Asuncion;QA|Asia/Qatar;RE|Indian/Reunion;RO|Europe/Bucharest;RS|Europe/Belgrade;RU|' +
  'Asia/Anadyr,Asia/Barnaul,Asia/Chita,Asia/Irkutsk,Asia/Kamchatka,Asia/Khandyga,Asia/Krasnoyar' +
  'sk,Asia/Magadan,Asia/Novokuznetsk,Asia/Novosibirsk,Asia/Omsk,Asia/Sakhalin,Asia/Srednekolyms' +
  'k,Asia/Tomsk,Asia/Ust-Nera,Asia/Vladivostok,Asia/Yakutsk,Asia/Yekaterinburg,Europe/Astrakhan' +
  ',Europe/Kaliningrad,Europe/Kirov,Europe/Moscow,Europe/Samara,Europe/Saratov,Europe/Ulyanovsk' +
  ',Europe/Volgograd;RW|Africa/Kigali;SA|Asia/Riyadh;SB|Pacific/Guadalcanal;SC|Indian/Mahe;SD|A' +
  'frica/Khartoum;SE|Europe/Stockholm;SG|Asia/Singapore;SH|Atlantic/St_Helena;SI|Europe/Ljublja' +
  'na;SJ|Arctic/Longyearbyen;SK|Europe/Bratislava;SL|Africa/Freetown;SM|Europe/San_Marino;SN|Af' +
  'rica/Dakar;SO|Africa/Mogadishu;SR|America/Paramaribo;SS|Africa/Juba;ST|Africa/Sao_Tome;SV|Am' +
  'erica/El_Salvador;SX|America/Lower_Princes;SY|Asia/Damascus;SZ|Africa/Mbabane;TC|America/Gra' +
  'nd_Turk;TD|Africa/Ndjamena;TF|Indian/Kerguelen;TG|Africa/Lome;TH|Asia/Bangkok;TJ|Asia/Dushan' +
  'be;TK|Pacific/Fakaofo;TL|Asia/Dili;TM|Asia/Ashgabat;TN|Africa/Tunis;TO|Pacific/Tongatapu;TR|' +
  'Europe/Istanbul;TT|America/Port_of_Spain;TV|Pacific/Funafuti;TW|Asia/Taipei;TZ|Africa/Dar_es' +
  '_Salaam;UA|Europe/Kyiv,Europe/Simferopol;UG|Africa/Kampala;UM|Pacific/Midway,Pacific/Wake;US' +
  '|America/Adak,America/Anchorage,America/Boise,America/Chicago,America/Denver,America/Detroit' +
  ',America/Indiana/Indianapolis,America/Indiana/Knox,America/Indiana/Marengo,America/Indiana/P' +
  'etersburg,America/Indiana/Tell_City,America/Indiana/Vevay,America/Indiana/Vincennes,America/' +
  'Indiana/Winamac,America/Juneau,America/Kentucky/Louisville,America/Kentucky/Monticello,Ameri' +
  'ca/Los_Angeles,America/Menominee,America/Metlakatla,America/New_York,America/Nome,America/No' +
  'rth_Dakota/Beulah,America/North_Dakota/Center,America/North_Dakota/New_Salem,America/Phoenix' +
  ',America/Sitka,America/Yakutat,Pacific/Honolulu;UY|America/Montevideo;UZ|Asia/Samarkand,Asia' +
  '/Tashkent;VA|Europe/Vatican;VC|America/St_Vincent;VE|America/Caracas;VG|America/Tortola;VI|A' +
  'merica/St_Thomas;VN|Asia/Ho_Chi_Minh;VU|Pacific/Efate;WF|Pacific/Wallis;WS|Pacific/Apia;YE|A' +
  'sia/Aden;YT|Indian/Mayotte;ZA|Africa/Johannesburg;ZM|Africa/Lusaka;ZW|Africa/Harare';

let index: Map<string, string> | null = null;

/** ISO 3166-1 alpha-2 for an IANA zone, or undefined for aliases and unknown zones. */
export function countryForTimezone(zone: string): string | undefined {
  if (!index) {
    index = new Map();
    for (const group of PACKED.split(';')) {
      const [cc, zones] = group.split('|');
      if (!cc || !zones) continue;
      for (const z of zones.split(',')) index.set(z, cc);
    }
  }
  return index.get(zone);
}
