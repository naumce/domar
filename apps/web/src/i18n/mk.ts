export default {
  app: { name: 'domar', loading: 'Вчитување…', save: 'Зачувај', cancel: 'Откажи', create: 'Креирај', edit: 'Измени', delete: 'Избриши', confirmDelete: 'Дали сте сигурни?', actions: 'Акции', search: 'Пребарај', empty: 'Нема податоци', yes: 'Да', no: 'Не', error: 'Настана грешка' },
  nav: { dashboard: 'Контролна табла', buildings: 'Згради', services: 'Услуги', contacts: 'Контакти', invoices: 'Фактури', payments: 'Плаќања', taxRates: 'Даночни стапки', settings: 'Поставки', logout: 'Одјави се', portal: 'Портал за сопственици' },
  auth: {
    login: 'Најави се', register: 'Отвори сметка', tenantSlug: 'Организација (слаг)', email: 'Е-пошта', password: 'Лозинка', firstName: 'Име', lastName: 'Презиме', orgName: 'Име на фирма', noAccount: 'Нема сметка?', haveAccount: 'Веќе имате сметка?',
    errors: { invalid_credentials: 'Погрешна организација, е-пошта или лозинка.', slug_taken: 'Тој слаг е веќе зафатен.', validation: 'Проверете ги внесените податоци.', generic: 'Настана грешка. Обидете се повторно.' },
  },
  dashboard: { welcome: 'Добредојде, {name}', buildings: 'Згради', units: 'Единици', owners: 'Сопственици', billed: 'Фактурирано овој месец', unpaid: 'Неплатени фактури', paid: 'Платено овој месец', outstanding: 'Ненаплатено' },
  taxRates: { title: 'Даночни стапки', name: 'Име', rate: 'Стапка (%)', isDefault: 'Стандардна', add: 'Додади стапка', makeDefault: 'Постави стандардна' },
  contacts: { title: 'Контакти', add: 'Додади контакт', kind: 'Тип', person: 'Физичко лице', company: 'Правно лице', companyNumber: 'Матичен број', vatNumber: 'Даночен број', phone: 'Телефон', address: 'Адреса', notes: 'Белешки', statement: 'Картица', balance: 'Салдо', allBuildings: 'Сите згради' },
  buildings: {
    title: 'Згради', add: 'Додади зграда', name: 'Име', address: 'Адреса', city: 'Град', postalCode: 'Поштенски број', representative: 'Претставник', none: '— нема —', shareBasis: 'Основ за распределба',
    shareBasisOptions: { area: 'По површина (m²)', equal: 'Рамномерно', custom: 'Сопственички удел' }, regularFundAccount: 'Сметка редовен фонд', reserveFundAccount: 'Сметка резервен фонд', unitCount: 'Единици',
  },
  units: {
    title: 'Единици', add: 'Додади единица', label: 'Број', floor: 'Кат', kind: 'Тип', areaM2: 'Површина (m²)', ownershipShare: 'Сопственички удел (0–1, пр. 0.0125)', owner: 'Сопственик', attachedTo: 'Прикачено на', notAttached: '— се фактурира одделно —',
    kinds: { apartment: 'Стан', commercial: 'Деловен простор', parking: 'Паркинг', storage: 'Остава', other: 'Друго' },
    errors: { label_taken: 'Единица со тој број веќе постои.', invalid_attachment: 'Може да се прикачи само на стан или деловен простор во истата зграда.', invalid_reference: 'Избраниот контакт не постои.' },
  },
  portal: { title: 'Портал за сопственици', comingSoon: 'Наскоро.' },
  services: {
    title: 'Услуги', add: 'Додади услуга', name: 'Име', category: 'Категорија', pricing: 'Модел на цена',
    pricingOptions: { fixed_per_unit: 'Фиксно по единица', per_m2: 'По m²', shared_total: 'Заедничко (се дели)' },
    defaultPrice: 'Стандардна цена', taxRate: 'Даночна стапка', noTax: 'Без данок', recurring: 'Периодична', oneTime: 'Еднократна', appliesTo: 'Се однесува на', allKinds: 'Сите типови',
  },
  billing: {
    regular: 'Редовен фонд', reserve: 'Резервен фонд', fund: 'Фонд', amount: 'Износ', quantity: 'Количина', unitPrice: 'Цена', tax: 'ДДВ', total: 'Вкупно', subtotal: 'Нето',
    previousBalance: 'Претходно салдо', amountDue: 'За плаќање', buildingWide: 'За зградата', ownerShare: 'Ваш дел', description: 'Опис', period: 'Период', status: 'Статус',
    paid: 'Платено', outstanding: 'Преостанато',
  },
  buildingServices: {
    title: 'Периодични услуги', attach: 'Додади периодична услуга', frequency: 'Фреквенција', monthly: 'Месечно', everyN: 'На секои N месеци', intervalMonths: 'Интервал (месеци)',
    startsPeriod: 'Од период', endsPeriod: 'До период', overridePrice: 'Цена за оваа зграда (опционално)', detach: 'Отстрани', alreadyAttached: 'Услугата е веќе додадена на зградата.',
  },
  reserveFund: {
    title: 'Резервен фонд', basis: 'Основ', perUnit: 'По единица', perM2: 'По m²', active: 'Активен', balance: 'Состојба', billed: 'Фактурирано на сопственици',
    openingBalance: 'Почетно салдо', addOpening: 'Внеси почетно салдо', expenses: 'Трошоци', addExpense: 'Евидентирај трошок', supplier: 'Добавувач', paidAt: 'Платено на',
    void: 'Поништи', voided: 'Поништено', transactions: 'Трансакции', voidReason: 'Причина за поништување',
    kind: { opening: 'Почетно салдо', expense: 'Трошок', adjustment: 'Корекција', payment: 'Уплата', charge: 'Задолжување' },
  },
  periods: {
    title: 'Пресметки', create: 'Нов период', exists: 'Периодот веќе постои.', managementFee: 'Надоместок за управување (по единица)', managementFeeTax: 'ДДВ на надоместокот', numbering: 'Нумерација',
    prefix: 'Префикс', suffix: 'Суфикс', lines: 'Ставки', addLine: 'Додади ставка', fromService: 'Од услуга', auto: 'Авто', manual: 'Рачно', note: 'Забелешка (задолжителна за авто ставки)',
    refresh: 'Освежи авто ставки', generate: 'Генерирај фактури', regenerate: 'Генерирај повторно', deleteDrafts: 'Избриши нацрти', publish: 'Објави ги сите',
    publishConfirm: 'Објавените фактури не може да се избришат. Продолжи?', warnings: 'Предупредувања', noteRequired: 'Внесете забелешка за измена на авто ставка.', nothingToPublish: 'Нема нацрти за објавување.', editSettings: 'Уреди поставки',
    warning: {
      missing_area: 'Единица {unit} нема површина — не учествува во распределбата по m².', missing_share: 'Единица {unit} нема сопственички удел.',
      no_owner: 'Единица {unit} нема сопственик — не е фактурирана.', no_weight: 'Ставка без единици за распределба — изоставена.',
      target_no_owner: 'Единица {unit} е прикачена на единица без сопственик — не е фактурирана.', no_units: 'Ставка без единици на кои се однесува — изоставена.',
    },
    status: { open: 'Отворен', generated: 'Нацрти', published: 'Објавен' },
    invoices: 'Фактури', locked: 'Периодот е објавен и не може да се менува.',
  },
  invoices: {
    title: 'Фактури', number: 'Број', owner: 'Сопственик', building: 'Зграда',
    status: { draft: 'Нацрт', published: 'Објавена', partially_paid: 'Делумно платена', paid: 'Платена', cancelled: 'Откажана' },
    openHtml: 'Отвори (HTML)', downloadPdf: 'Преземи PDF', deleteDraft: 'Избриши нацрт', reserveBalance: 'Состојба на резервен фонд на зградата',
    issued: 'Издадена', due: 'Рок', units: 'Единици',
    lineKind: { service: 'Услуга', manual: 'Ставка', reserve_fund: 'Резервен фонд', management_fee: 'Управување' },
  },
  payments: {
    title: 'Плаќања', record: 'Евидентирај уплата', amount: 'Износ', method: 'Начин',
    methods: { cash: 'Готовина', bank_transfer: 'Банкарски трансфер', card: 'Картичка', cheque: 'Чек', other: 'Друго' },
    paidAt: 'Датум на уплата', reference: 'Повикување', note: 'Белешка', void: 'Поништи', voidReason: 'Причина за поништување',
    status: { completed: 'Завршено', voided: 'Поништено' },
    received: 'Примено', count: 'Плаќања', voidedCount: 'Поништени', from: 'Од', to: 'До', none: 'Нема плаќања', onAccount: 'Аконтација (без фактура)',
  },
  statements: {
    title: 'Изводи', upload: 'Увези извод', file: 'Датотека (MT940 или CSV)', lines: 'Ставки', imported: 'Увезен', matched: 'Усогласени', skipped: 'Прескокнати (дупликати)',
    status: { unmatched: 'Неусогласено', suggested: 'Предлог', matched: 'Усогласено', ignored: 'Игнорирано' },
    confirm: 'Потврди', ignore: 'Игнорирај', unmatch: 'Раздвои', suggested: 'Предложена фактура', chooseInvoice: 'Избери фактура', warnings: 'Предупредувања при увоз', counterparty: 'Уплаќач',
    unknownFormat: 'Форматот на датотеката не е препознаен (MT940 или CSV со колони date и amount).',
  },
  settings: {
    title: 'Поставки на организацијата', timezone: 'Временска зона', bankName: 'Банка', bankAccount: 'Сметка', companyNumber: 'ЕМБС', vatNumber: 'ЕДБ', saved: 'Зачувано.',
  },
  ledger: {
    kind: { charge: 'Задолжување', payment: 'Уплата', adjustment: 'Корекција', opening: 'Почетно салдо', expense: 'Трошок' },
  },
} as const;
