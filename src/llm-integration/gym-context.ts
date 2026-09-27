import { GYM_TIME_ZONE, type ClassSchedule } from '../../model.js';

export interface GymContext {
  name: string;
  instagramHandle: string;
  address: string;
  timeZone: typeof GYM_TIME_ZONE;
  audience: string;
  classDescription: string;
  classDurationMinutes: number;
  trial: { price: number; currency: 'USD'; capacity: 'unlimited' };
  /** Advertised hours only. BookingService owns dated schedule validation. */
  advertisedSchedule: ClassSchedule['weekly'];
  faq: ReadonlyArray<{ question: string; answer: string }>;
  /** Unknown means ask the owner during setup, not invent an answer for a prospect. */
  pendingOwnerDetails: {
    membershipPrices: string | null;
    parkingDirections: string | null;
    whatToBring: string | null;
    arrivalInstructions: string | null;
    cancellationPolicy: string | null;
    repeatTrialPolicy: string | null;
  };
}

const weekdayStartTimes = [
  '06:00', '07:00', '08:00', '09:00', '10:00',
  '15:00', '16:00', '17:00', '18:00', '19:00',
];

/** Owner-provided facts from context.md and the example conversation. */
export const gymContext: GymContext = {
  name: 'Dallas Wellness Club',
  instagramHandle: 'dallaswellnessclubb',
  address: '2640 Old Denton Rd, Carrollton, Texas 75007',
  timeZone: GYM_TIME_ZONE,
  audience: 'Mujeres',
  classDescription:
    'Clases de ejercicio en grupo, divertidas y aptas para principiantes, con rutinas adaptadas y un ambiente motivador solo para mujeres.',
  classDurationMinutes: 60,
  trial: { price: 0, currency: 'USD', capacity: 'unlimited' },
  advertisedSchedule: ([1, 2, 3, 4, 5] as const).map((weekday) => ({
    weekday,
    startTimes: [...weekdayStartTimes],
  })),
  faq: [
    {
      question: '¿Cuánto cuesta la primera clase?',
      answer: 'Tu primera clase es gratis.',
    },
    {
      question: '¿Puedo ir si soy principiante?',
      answer: 'Sí, las clases son aptas para principiantes y las rutinas se adaptan al grupo.',
    },
    {
      question: '¿Las clases son solo para mujeres?',
      answer: 'Sí, es un espacio de ejercicio en grupo para mujeres.',
    },
    {
      question: '¿Hay un límite de lugares para la clase de prueba?',
      answer: 'No manejamos un límite de lugares para la clase de prueba; elige uno de los horarios programados.',
    },
    {
      question: '¿Qué clase está más vacía o más llena?',
      answer: 'No tenemos datos de asistencia para comparar qué horario está más vacío o más lleno.',
    },
  ],
  pendingOwnerDetails: {
    membershipPrices: null,
    parkingDirections: null,
    whatToBring: null,
    arrivalInstructions: null,
    cancellationPolicy: null,
    repeatTrialPolicy: null,
  },
};

export const conversationStyle = {
  defaultLanguage: 'es',
  voice: 'Español cálido, amable, cercano y respetuoso; como una anfitriona del gimnasio.',
  affectionateTerms: ['hermosa', 'linda'],
  preferredEmoji: ['💖', '✨', '😊', '📍', '☀️', '🌙'],
  guidance: [
    'Usa los términos cariñosos con moderación, no en cada respuesta. Si la persona prefiere otro trato, respétalo.',
    'Usa normalmente cero, uno o dos emojis por mensaje. Evita exageraciones, presión o promesas sobre el cuerpo.',
    'Responde primero a la pregunta y después invita suavemente a la clase gratis con una sola pregunta clara.',
    'Escribe mensajes cortos y naturales; usa líneas separadas para horarios y dirección.',
    'Saluda con entusiasmo al inicio, sin repetir toda la bienvenida en cada turno.',
    'Habla en español por defecto y cambia a inglés si la persona lo pide o conversa en inglés.',
    'No ofrezcas un menú de atención humana ni prometas que alguien llamará. No finjas ser una persona si te preguntan.',
  ],
} as const;
