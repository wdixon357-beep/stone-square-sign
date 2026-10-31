# Muse Assistant capability coverage

Every existing named permission and owner-only workflow is represented. Personal and unavailable entries cannot be granted for delegate execution. Existing office and record rules still apply.

| Action | Work area | Mode | Boundary |
| --- | --- | --- | --- |
| building.request | Prepare building requests | personal | Prepare the request for your own review and submission. The existing portal requires a human session. |
| building.view | Review building requests | standing | View request details without retrieving reusable signature images. |
| building.decide | Approve or decline building requests | personal | Open the current request for your decision. Approval applies your saved signature. |
| calendar.view | View Lodge Calendar | standing | Read the existing calendar. |
| calendar.manage | Manage Lodge Calendar | approval | Propose exact event additions, changes or removals. |
| reports.create | Prepare reports | approval | Organize supplied material under existing source and spending limits. Signed report access stays personal. |
| minutes.view | View meeting minutes | standing | Read current minutes and historical records through the assistant read projection. |
| minutes.prepare | Prepare and edit minutes | approval | Prepare exact draft changes, preserving source, preparer ownership and confirmations. |
| treasury.view | View treasurer reports | standing | Read reports and their current state. |
| treasury.prepare | Prepare treasurer reports | approval | Propose exact draft work subject to assignment, period and financial checks. Correcting a source-matched financial value and making personal review confirmations require your own action. |
| treasury.upload | Provide banking records | approval | Provide exact files for an approved operation under the existing upload permission. |
| dues.self | View your dues | standing | Read the owner account’s current dues. |
| dues.ledger | View dues ledger | standing | Read the Lodge ledger and exports. |
| dues.manage | Record dues activity | approval | Propose exact adjustments or reversals; existing evidence rules remain. |
| suggestions.create | Prepare confidential suggestions | approval | Propose an exact confidential submission. |
| documents.status | View dispensations | standing | Read assigned or owner-visible documents, statuses and retained PDFs. |
| documents.sign | Sign assigned dispensations | personal | Open the complete document for your own signature. |
| candidates.view | View Candidate Tracker | unavailable | The tracker requires an owner assertion which cannot be handed to an assistant credential. |
| candidates.edit | Edit Candidate Tracker | unavailable | External tracker changes are not exposed through this service identity. |
| proposals.create | Submit personal dispensation proposals | unavailable | Proposal preparation is assigned to Wardens. Owner review is listed separately. |
| signature.manage | Manage your signature | personal | Signature images and signature changes require your own action. |
| settings.manage | Manage your settings | personal | Session, sign-in and personal security changes require your own action. |
| owner.profile | Read owner workspace identity | standing | Read your current name, office and workspace permissions. |
| owner.officers | Review officer access | standing | Read officer, invitation and permission metadata. |
| owner.access | Change officer access | approval | Propose exact office, permission, invitation or revocation changes. |
| owner.activity | Review private activity | standing | Read existing activity and incident metadata without creating synthetic incidents. |
| owner.suggestions | Review confidential suggestions | standing | Read suggestions visible to the owner. |
| owner.suggestion-status | Update suggestion status | approval | Propose a status change on an existing suggestion. |
| owner.agendas | Prepare meeting agendas | approval | Propose exact agenda changes without signing. |
| owner.agendas-view | View meeting agendas | standing | Read private owner agendas and previews. |
| owner.correspondence | Prepare Lodge correspondence | approval | Prepare or return exact drafts. Existing signer assignment and office rules remain. |
| owner.correspondence-view | Review correspondence | standing | Read owner-visible letters and PDFs. |
| owner.correspondence-sign | Sign correspondence | unavailable | Correspondence signing belongs to the assigned Secretary or Assistant Secretary, not the owner. |
| owner.documents | Prepare dispensations | approval | Propose exact documents and owner workflow changes. |
| owner.dispensation-sign | Create and sign a dispensation | personal | Review the completed official template and personally create it with your saved signature. |
| owner.record-approval | Record an approval assertion | personal | You record and confirm the actual approval evidence yourself. |
| owner.proposals-view | Review Warden proposals | standing | Read all submitted proposals. |
| owner.proposals-decide | Decide Warden proposals | personal | Review the exact proposal yourself. Approval creates the document with your saved signature. |
| owner.minutes-preparer | Attest as actual minutes preparer | personal | Only your own draft can reach your preparer attestation. |
| owner.minutes-master | Attest as Worshipful Master | personal | Open submitted minutes, review current corrections and tap to attest. |
| owner.minutes-lodge-approval | Record Lodge approval of minutes | personal | You confirm the actual Lodge approval date and evidence. |
| owner.minutes-workflow | Manage minutes workflow | approval | Propose exact distribution markers, reopening or controlled deletion. |
| owner.treasury-attest | Attest to your treasurer report | personal | Only the actual assigned preparer can attest. |
| owner.treasury-access | Manage treasury assignments and access | approval | Propose exact access changes under existing rules. |
| owner.treasury-workflow | Manage treasurer report workflow | approval | Propose exact distribution markers or controlled draft deletion. |
| owner.building-file | File a completed building agreement | personal | You inspect and file the current fully executed agreement. |
| owner.building-attest | Secretary building attestation | unavailable | This attestation belongs to the Secretary or Assistant Secretary. |
| owner.building-agreement | Review captured building signatures | personal | The captured agreement contains reusable signature images and opens only in your own session. |
| owner.report-signature | Use owner signature in Report Generator | personal | Signature images, signed handoffs and final report delivery require your own action. |
| owner.received-reports | Review received officer reports | standing | Read existing submitted reports without fabricating a new submission. |
