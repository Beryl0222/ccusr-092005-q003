// 把既有领域样例（fixtures/seed.json）纳入服务：
// 工作室与课程记录登记为带稳定标识的事实，后续证据、认定、班次均引用这些标识。

import { loadSeed } from "./seed.js";

export async function ingestSeed(service, path = "fixtures/seed.json") {
  const data = await loadSeed(path);
  const result = { studios: [], courses: [], skipped: [] };

  for (const record of data.records) {
    if (record.kind === "studio") {
      const studio = service.registerStudio({
        studioId: record.id,
        craft: record.craft,
        mentorSlots: record.mentor_slots,
        requiredSkills: record.required_skills,
      });
      result.studios.push(studio.studioId);
    } else if (record.kind === "course") {
      const course = service.registerCourse({
        courseId: record.id,
        school: record.school,
        stages: record.stages,
        employmentLinked: record.employment_linked,
      });
      result.courses.push(course.courseId);
    } else {
      result.skipped.push(record.id);
    }
  }

  return result;
}
