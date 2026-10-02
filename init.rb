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
end

# The print page is not tied to a project: it collects issues from anywhere,
# so it sits in the same cross-project sidebar as "Issues" and "Gantt".
Redmine::MenuManager.map :application_menu do |menu|
  menu.push :niimbot_labels,
            {controller: 'niimbot_labels', action: 'index'},
            caption: :label_niimbot_labels,
            if: proc { User.current.logged? && User.current.allowed_to?(:view_issues, nil, global: true) }
end
