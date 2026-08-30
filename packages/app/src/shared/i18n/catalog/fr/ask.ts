export const ask = {
  title: 'Ask',

  noProviderTitle: 'Connecter un fournisseur IA',
  noProviderSubtitle:
    'Ask répond aux questions sur ce projet avec le modèle que vous fournissez. Ajoutez-en un dans les réglages pour l’activer.',
  openAiSettings: 'Ouvrir les réglages IA',

  chats: 'Conversations',
  newChat: 'Nouvelle conversation',
  noChats: 'Aucune conversation.',
  untitled: 'Sans titre',
  deleteChat: 'Supprimer la conversation (⌫)',
  connectingProvider: 'Connexion…',
  noProvider: 'Aucun fournisseur',

  showContextPanel: 'Afficher le panneau de contexte',
  hideContextPanel: 'Masquer le panneau de contexte',
  showContext: 'Afficher le contexte',
  hideContext: 'Masquer le contexte',
  loadingChat: 'Chargement de la conversation',
  conversation: 'Conversation',

  emptyTitle: 'Posez une question sur ce code',
  emptySubtitle:
    'Les réponses s’appuient sur le graphe indexé — les fichiers, symboles et décisions que ce projet contient déjà.',
  slashCommands: 'Commandes slash',
  slashFind: 'Rechercher des symboles par nom',
  slashImpact: 'Afficher l’impact d’un changement sur un symbole',
  slashScan: 'Lancer une analyse de sécurité (principaux résultats OWASP)',
  suggestionAuth: 'Comment fonctionne l’authentification ?',
  suggestionPlugins: 'Explique le système de plugins',
  suggestionRoutes: 'Où sont les routes de l’API ?',

  retrieving: 'Recherche dans le code',
  thinking: 'Réflexion',
  sendAgain: 'Renvoyer',

  composerLabel: 'Poser une question sur ce projet',
  composerPlaceholder: 'Posez une question sur ce projet, ou tapez / pour les commandes',
  stopGenerating: 'Arrêter la génération',
  sendMessage: 'Envoyer le message',
  sendShortcut: 'Envoyer (⌘↵)',
  copyCode: 'Copier le code',
  copied: 'Copié',

  context: 'Contexte',
  noContextTitle: 'Aucun contexte pour l’instant',
  noContextSubtitle:
    'Les fichiers, symboles et décisions lus par le modèle apparaissent ici après l’envoi d’un message. Les commandes slash ne récupèrent pas de contexte.',
  filesRead: 'Fichiers lus',
  noFilesRead: 'Aucun fichier lu.',
  symbolsRead: 'Symboles lus',
  decisionsConsulted: 'Décisions consultées',

  loadSessionFailed: 'Échec du chargement de la session',
  createSessionFailed: 'Échec de la création de la session',
  noSession: 'Impossible d’établir une session de conversation',
  slashFailed: 'La commande slash a échoué',
  unknownError: 'Erreur inconnue',
} as const;
