export default {
  app: { name: 'domar', loading: 'Вчитување…', save: 'Зачувај', cancel: 'Откажи', create: 'Креирај', edit: 'Измени', delete: 'Избриши', confirmDelete: 'Дали сте сигурни?', actions: 'Акции', search: 'Пребарај', empty: 'Нема податоци', yes: 'Да', no: 'Не', error: 'Настана грешка' },
  nav: { dashboard: 'Контролна табла', buildings: 'Згради', contacts: 'Контакти', taxRates: 'Даночни стапки', settings: 'Поставки', logout: 'Одјави се', portal: 'Портал за сопственици' },
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
} as const;
