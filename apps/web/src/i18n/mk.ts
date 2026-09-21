export default {
  app: { name: 'domar', loading: 'Вчитување…', save: 'Зачувај', cancel: 'Откажи', create: 'Креирај', edit: 'Измени', delete: 'Избриши', confirmDelete: 'Дали сте сигурни?', actions: 'Акции', search: 'Пребарај', empty: 'Нема податоци', yes: 'Да', no: 'Не', error: 'Настана грешка' },
  nav: { dashboard: 'Контролна табла', buildings: 'Згради', services: 'Услуги', contacts: 'Контакти', invoices: 'Фактури', taxRates: 'Даночни стапки', settings: 'Поставки', logout: 'Одјави се', portal: 'Портал за сопственици' },
  auth: {
    login: 'Најави се', register: 'Отвори сметка', tenantSlug: 'Организација (слаг)', email: 'Е-пошта', password: 'Лозинка', firstName: 'Име', lastName: 'Презиме', orgName: 'Име на фирма', noAccount: 'Нема сметка?', haveAccount: 'Веќе имате сметка?',
    errors: { invalid_credentials: 'Погрешна организација, е-пошта или лозинка.', slug_taken: 'Тој слаг е веќе зафатен.', validation: 'Проверете ги внесените податоци.', generic: 'Настана грешка. Обидете се повторно.' },
  },
  dashboard: { welcome: 'Добредојде, {name}', buildings: 'Згради', units: 'Единици', contacts: 'Контакти' },
  taxRates: { title: 'Даночни стапки', name: 'Име', rate: 'Стапка (%)', isDefault: 'Стандардна', add: 'Додади стапка', makeDefault: 'Постави стандардна' },
  contacts: { title: 'Контакти', add: 'Додади контакт', kind: 'Тип', person: 'Физичко лице', company: 'Правно лице', companyNumber: 'Матичен број', vatNumber: 'Даночен број', phone: 'Телефон', address: 'Адреса', notes: 'Белешки' },
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
  },
  buildingServices: {
    title: 'Периодични услуги', attach: 'Додади периодична услуга', frequency: 'Фреквенција', monthly: 'Месечно', everyN: 'На секои N месеци', intervalMonths: 'Интервал (месеци)',
    startsPeriod: 'Од период', endsPeriod: 'До период', overridePrice: 'Цена за оваа зграда (опционално)', detach: 'Отстрани',
  },
  reserveFund: {
    title: 'Резервен фонд', basis: 'Основ', perUnit: 'По единица', perM2: 'По m²', active: 'Активен', balance: 'Состојба', billed: 'Фактурирано на сопственици',
    openingBalance: 'Почетно салдо', addOpening: 'Внеси почетно салдо', expenses: 'Трошоци', addExpense: 'Евидентирај трошок', supplier: 'Добавувач', paidAt: 'Платено на',
    void: 'Поништи', voided: 'Поништено', transactions: 'Трансакции',
  },
  periods: {
    title: 'Пресметки', create: 'Нов период', managementFee: 'Надоместок за управување (по единица)', managementFeeTax: 'ДДВ на надоместокот', numbering: 'Нумерација',
    prefix: 'Префикс', suffix: 'Суфикс', lines: 'Ставки', addLine: 'Додади ставка', fromService: 'Од услуга', auto: 'Авто', manual: 'Рачно', note: 'Забелешка (задолжителна за авто ставки)',
    refresh: 'Освежи авто ставки', generate: 'Генерирај фактури', regenerate: 'Генерирај повторно', deleteDrafts: 'Избриши нацрти', publish: 'Објави ги сите',
    publishConfirm: 'Објавените фактури не може да се избришат. Продолжи?', warnings: 'Предупредувања',
    warning: {
      missing_area: 'Единица {unit} нема површина — не учествува во распределбата по m².', missing_share: 'Единица {unit} нема сопственички удел.',
      no_owner: 'Единица {unit} нема сопственик — не е фактурирана.', no_weight: 'Ставка без единици за распределба — изоставена.',
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
} as const;
