# Test data for run.js, on a fresh Redmine with default data loaded:
#   bin/rails runner plugins/redmine_niimbot_labels/test/e2e/seed.rb
# Idempotent. Creates:
#   project "sklad"  - module enabled, issues #1-#3
#   project "office" - module disabled, issue #4
#   user "ivan" / "ivan12345" - Developer in both projects
admin = User.find_by!(login: 'admin')
admin.password = admin.password_confirmation = 'admin12345'
admin.must_change_passwd = false
admin.language = 'ru'
admin.save!
Setting.host_name = 'localhost:3000'
Setting.protocol = 'http'

def project(identifier, name, modules)
  Project.find_by(identifier: identifier) ||
    Project.create!(name: name, identifier: identifier, is_public: false,
                    tracker_ids: Tracker.pluck(:id), enabled_module_names: modules)
end

sklad = project('sklad', 'Склад', %w(issue_tracking niimbot_labels))
office = project('office', 'Офис', %w(issue_tracking))

admin_issue = lambda do |p, subject|
  Issue.find_by(subject: subject) ||
    Issue.create!(project: p, tracker: Tracker.first, author: admin, subject: subject,
                  status: IssueStatus.first, priority: IssuePriority.first)
end
admin_issue.(sklad, 'Осциллограф Tektronix TDS2012C, инв. 0451')
admin_issue.(sklad, 'Паяльная станция')
admin_issue.(sklad, 'Коробка с разъёмами BNC-SMA-переходники разные очень длинное название для проверки переноса строк')
admin_issue.(office, 'Кофемашина')

ivan = User.find_by(login: 'ivan') || User.new(firstname: 'Иван', lastname: 'Петров', mail: 'ivan@example.net').tap do |u|
  u.login = 'ivan'
  u.password = u.password_confirmation = 'ivan12345'
  u.language = 'ru'
  u.save!
end
developer = Role.givable.find_by!(position: 2)
[sklad, office].each do |p|
  Member.create!(principal: ivan, project: p, roles: [developer]) unless Member.exists?(user_id: ivan.id, project_id: p.id)
end
p Issue.order(:id).pluck(:id, :project_id, :subject)
