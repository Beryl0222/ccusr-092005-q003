# 传统技艺学徒成长档案与岗位衔接服务

记录大师工作室、定制课程、学徒阶段成果和岗位能力要求，并在其上提供
**成长与岗位衔接服务**：课程目标、工艺能力、现场作品、导师观察各自保留来源，
能力认定由学校与工作室按当时规则共同确认；补充或撤回证据只产生新结论，
不抹掉历史。

执行 `npm test` 可运行全部测试。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/events.js` | 只增事件日志，支持幂等键；撤回、作废、规则升级都只能追加事件 |
| `src/rules.js` | 规则版本（v1 单源可认定；v2 校室双侧来源 + 食品安全准入 + 协作按贡献计）与达标评估 |
| `src/service.js` | 学徒成长与岗位衔接领域服务（证据、认定、授权摘要、班次匹配与级联重算、上岗追溯） |
| `src/ingest.js` | 把 `fixtures/seed.json` 中的既有工作室、课程记录纳入服务 |
| `src/seed.js` | 既有领域样例读取与结构校验 |

## 关键规则

- **来源互不相认 → 共同确认**：学校成绩/课程目标属学校侧，师傅观察/门店作品属
  工作室侧；v2 规则下每项能力须两侧证据齐备，且认定决定由校室双方确认人共同作出。
- **历史只增**：每条认定结论链向被它取代的上一条（`supersedes`）。撤回证据
  追加撤回事件并重算出"不足"的新结论；规则升级按新版本重确认，旧结论保留原版本号。
- **重复提交幂等**：同一学徒、能力、来源、出处的重复提交只落一条事件，不重复出结论。
- **协作作品署名贡献**：同一作品多人协作时逐人记录贡献，仅本人贡献计入本人证据。
- **授权携带**：学徒转到其他工作室，只能导出本人授权范围内、当前仍有效的
  能力摘要；联系方式与未公开评价不进入摘要；授权撤回后接收方立即失去访问。
- **班次匹配**：仅匹配能力已共同确认、食品安全已通过、时间不冲突的人。
- **自动失效与重算**：导师停带 → 其班次安排作废、班次挂起，重新指派导师后重算；
  工坊暂停生产 → 未开始班次安排作废且停产期间不排人，复工后自动重算。
- **一次追溯**：门店查看一次上岗决定，即可追到课程/作品等证据、双方确认者、
  规则版本以及仍缺的训练（追溯视图不含联系方式与未公开评价原文）。

## 事件类型一览

`StudioRegistered` / `CourseRegistered` / `ApprenticeEnrolled` /
`MentorAssigned` / `MentorStopped` / `ShiftMentorReplaced` /
`ProductionPaused` / `ProductionResumed` /
`EvidenceSubmitted` / `EvidenceWithdrawn` /
`WorkRecorded` / `ContributionRecorded` /
`FoodSafetyCleared` / `FoodSafetyRevoked` /
`DecisionRecorded` / `ConsentGranted` / `ConsentRevoked` / `SummaryExported` /
`ShiftOpened` / `AssignmentRecorded` / `AssignmentsVoided`
