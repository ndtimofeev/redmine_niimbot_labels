require_relative 'lib/redmine_niimbot_labels'

Redmine::Plugin.register :redmine_niimbot_labels do
  name 'Niimbot Labels'
  description 'Prints issue labels (a QR code with the issue URL) on a NIIMBOT B1 ' \
              'straight from the browser over Web Bluetooth'
  version RedmineNiimbotLabels::VERSION
  url 'https://github.com/ndtimofeev/redmine_niimbot_labels'
  requires_redmine version_or_higher: '6.0'

  settings default: RedmineNiimbotLabels::DEFAULT_SETTINGS,
           partial: 'settings/niimbot_labels_settings'

  # A project module: label printing shows up only in projects that have
  # "Label printing" ticked in Settings > Modules, and only for roles with
  # the permission below (see db/migrate for who gets it on install).
  project_module :niimbot_labels do
    # read: printing changes nothing, so it also works in closed projects.
    permission :print_issue_labels, {niimbot_labels: [:index, :show]}, read: true
  end

  menu :project_menu, :niimbot_labels,
       {controller: 'niimbot_labels', action: 'index'},
       param: :project_id, caption: :label_niimbot_labels, after: :issues
end
