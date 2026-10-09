# Gives :print_issue_labels to every role that can already view issues, so
# that ticking the module in a project is enough to start printing there.
# Take it away from roles in Administration > Roles and permissions as needed.
# Anonymous is left out: printing needs a logged-in user anyway.
class GrantPrintIssueLabels < ActiveRecord::Migration[7.2]
  def up
    Role.where.not(builtin: Role::BUILTIN_ANONYMOUS).find_each do |role|
      role.add_permission!(:print_issue_labels) if role.has_permission?(:view_issues)
    end
  end

  def down
    Role.find_each {|role| role.remove_permission!(:print_issue_labels)}
  end
end
