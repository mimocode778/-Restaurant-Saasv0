// Talks to the API. The login lives in a protected cookie the page cannot read, so every
// request simply includes cookies; nothing secret is ever stored by this page.

export type Role = 'owner' | 'manager' | 'waiter'

export interface Me {
  userId: string
  restaurantId: string
  role: Role
  fullName: string
  method: 'password' | 'pin'
  twoStepEnabled: boolean
  expiresAt: string
}

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

// Turns the API's answer into one readable French sentence.
function messageFrom(status: number, body: unknown): string {
  const b = body as { message?: unknown; issues?: { message: string }[] } | null
  if (b?.issues?.length) return b.issues.map((i) => translate(i.message)).join(' · ')
  if (typeof b?.message === 'string') return translate(b.message)
  if (status === 0) return "Le serveur ne répond pas. Vérifiez qu'il est démarré."
  return `Erreur ${status}`
}

// The API answers in English; the people using the screens read French.
const FR: Record<string, string> = {
  'Wrong email or password': 'E-mail ou mot de passe incorrect',
  'Wrong code': 'Code incorrect',
  'Wrong PIN': 'Code PIN incorrect',
  'Too many attempts. Please wait 15 minutes and try again.': 'Trop de tentatives. Attendez 15 minutes puis réessayez.',
  'Enter the 6-digit code from your phone app': "Saisissez le code à 6 chiffres de l'application de votre téléphone",
  'Please log in': 'Veuillez vous connecter',
  'Your session has ended, please log in again': 'Votre session est terminée, reconnectez-vous',
  'Your role does not allow this': "Votre rôle ne permet pas cette action",
  'This name is already used': 'Ce nom est déjà utilisé',
  'This email is already used': 'Cet e-mail est déjà utilisé',
  'Unknown category': 'Catégorie inconnue',
  'A table already has this name': 'Une table porte déjà ce nom',
  'This position is outside the room': 'Cette position est en dehors de la salle',
  'Some items would end up outside the room: move them first': "Certains éléments seraient hors de la salle : déplacez-les d'abord",
  'No such item in the room': "Cet élément n'est plus dans la salle",
  'Archive or move its dishes first': "Archivez ou déplacez d'abord ses plats",
  'Its category is archived: move the dish first': "Sa catégorie est archivée : déplacez d'abord le plat",
  'No such dish on the menu': 'Ce plat n’est pas à la carte',
  'Your current password is wrong': 'Votre mot de passe actuel est incorrect',
  'This password is too common': 'Ce mot de passe est trop courant',
  'This password repeats the same few characters': 'Ce mot de passe répète trop les mêmes caractères',
  'The password must not contain the email address': "Le mot de passe ne doit pas contenir l'adresse e-mail",
  'A password needs at least 10 characters': 'Le mot de passe doit faire au moins 10 caractères',
  'A PIN is 4 to 6 digits': 'Le code PIN fait 4 à 6 chiffres',
  'A manager needs an email and a password': 'Un gérant a besoin d’un e-mail et d’un mot de passe',
  'A waiter needs a PIN': 'Un serveur a besoin d’un code PIN',
  'Wrong code. Check the time on your phone is correct.': "Code incorrect. Vérifiez que l'heure de votre téléphone est juste.",
  'Wrong password or code': 'Mot de passe ou code incorrect',
  'Two-step login is already on': 'La double vérification est déjà activée',
  'Log in with your email and password to do this': 'Connectez-vous avec e-mail et mot de passe pour faire cela',
}
function translate(m: string): string {
  return FR[m] ?? m
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, messageFrom(0, null), null)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) throw new ApiError(res.status, messageFrom(res.status, data), data)
  return data as T
}

export const get = <T>(path: string) => api<T>('GET', path)
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body ?? {})
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body)
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body)
