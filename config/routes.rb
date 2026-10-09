# The print page lives inside a project, so it is only reachable where the
# niimbot_labels module is enabled (see NiimbotLabelsController#authorize).
get 'projects/:project_id/niimbot_labels', to: 'niimbot_labels#index', as: 'project_niimbot_labels'
# No .json format on purpose: Redmine treats format=json as an API request and
# ignores the session cookie for it, so the print page could not use it.
get 'niimbot_labels/issues/:id', to: 'niimbot_labels#show', as: 'niimbot_label', constraints: {id: /\d+/}
get 'niimbot_labels/script', to: 'niimbot_labels#script', as: 'niimbot_labels_script'
