/**
 * 자동 계획 응답이 아직 인터뷰 단계인지 판정한다.
 *
 * workflow 마커는 계획 모델이 최종 체크리스트를 출력할 때만 넣도록
 * 프롬프트에서 계약한 종료 신호다. 마커가 없는 응답은 체크리스트가 없어도
 * 질문을 계속 주고받는 정상적인 인터뷰 턴일 수 있다.
 */
function shouldWaitForPlanningInterview(autoMode, responseWorkflowId) {
  return autoMode === true && !responseWorkflowId;
}

module.exports = {
  shouldWaitForPlanningInterview,
};
