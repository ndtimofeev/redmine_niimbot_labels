get 'niimbot_labels', to: 'niimbot_labels#index', as: 'niimbot_labels'
# No .json format on purpose: Redmine treats format=json as an API request and
# ignores the session cookie for it, so the print page could not use it.
get 'niimbot_labels/issues/:id', to: 'niimbot_labels#show', as: 'niimbot_label', constraints: {id: /\d+/}
get 'niimbot_labels/script', to: 'niimbot_labels#script', as: 'niimbot_labels_script'
